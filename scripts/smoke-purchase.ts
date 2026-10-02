// B3 purchase checks: PLAN §13 invoice, merge rule, supplier ledger (payments, returns, advance, cancel), isolation, exports.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const details = (r: Res) => (r.json.error as { details?: Record<string, unknown> } | undefined)?.details ?? {};

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: {
    name,
    address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' },
    phone: '033 2229 4410',
    drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418',
    drugLicenseExpiry: '2031-03',
    pricingMode: 'MRP_INCLUSIVE',
  },
  termsVersion: '2026-10',
  agree: true,
});

interface Supplier { id: string; name: string; code: string; payableBalance: number; advance: number; creditDays: number }
interface Saved { id: string; purchaseNumber: string; grandTotal: number; lines: number; fromAdvance: number; paymentNumber: string | null }
interface Alloc { kind: string; amount: number; refNumber: string | null }
interface PLine { batchId: string; batchNumber: string; how: string; quantityInBase: number; costPerBaseUnit: number; landingPerUnit: number; taxableAmount: number; cgst: number; sgst: number }
interface Purchase {
  id: string; purchaseNumber: string; status: string; grandTotal: number; paidAmount: number; dueAmount: number; paymentStatus: string;
  subtotal: number; totalDiscount: number; taxableAmount: number; cgst: number; sgst: number; roundOff: number;
  lines: PLine[]; allocations: Alloc[]; mrpChanges: { from: number; to: number }[]; canCancel: boolean; hasPhoto: boolean; dueDate: string; invoiceDate: string;
}
interface Ledger { opening: number; closing: number; total: number; rows: { kind: string; debit: number; credit: number; balance: number }[] }

const IST = 5.5 * 60 * 60 * 1000;
const isoDay = (offsetDays = 0) => new Date(Date.now() + IST + offsetDays * 86_400_000).toISOString().slice(0, 10);
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const units10 = { type: 'COUNT', base: 'CAPSULE', sale: 'STRIP', salePack: 10, purchase: 'STRIP', purchasePack: 1, allowLooseSale: true };

async function main() {
  const h = await startHarness();
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { SupplierModel } = await import('../src/modules/suppliers/supplier.model.js');
  const { PurchaseModel, SupplierPaymentModel } = await import('../src/modules/purchases/purchase.model.js');
  const { AttachmentModel } = await import('../src/modules/attachments/attachment.model.js');
  const { fyOf } = await import('../src/utils/fy.js');
  const fy = fyOf(new Date());

  const owner = await h.signIn('rohit@buy1.test');
  const shop1 = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shop1;
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  await SubscriptionModel.updateOne({ shopId: shop1 }, { $set: { maxUsers: 10 } });
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id ?? '';
  const mk = async (c: Client, name: string, units: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: 'A-2-1', reorderLevel: 300, reorderQuantity: 450, ...over })).id;
  const dolo = await mk(owner, 'Dolo 650 Tablet', units15);
  const amox = await mk(owner, 'Amoxyclav 625', units10, { defaultRack: 'A-3-2' });
  const pan = await mk(owner, 'Pan 40', units15);

  /** Every supplier: payableBalance = ledger = Σ open dues − advance, and advance only while nothing is due. */
  const books = async (label: string) => {
    const sups = await SupplierModel.find({ shopId: shop1 }).lean();
    let ok = sups.length > 0;
    const why: string[] = [];
    for (const s of sups) {
      const l = data<Ledger>(await owner.get(`/suppliers/${String(s._id)}/ledger?from=2000-01-01`));
      const due = (await PurchaseModel.find({ shopId: shop1, supplierId: s._id, status: 'active' }).lean()).reduce((a, p) => a + p.dueAmount, 0);
      const fine = l.total === s.payableBalance && l.closing === s.payableBalance && due - s.advance === s.payableBalance && s.advance >= 0 && (s.advance === 0 || due === 0);
      if (!fine) why.push(`${s.name}: bal ${String(s.payableBalance)} ledger ${String(l.total)} due ${String(due)} adv ${String(s.advance)}`);
      ok &&= fine;
    }
    check(`${label}: supplier balance = ledger = dues − advance (${String(sups.length)} suppliers)`, ok, why.join(' | '));
  };
  /** Ledger = stock, batch by batch (PLAN §12). */
  const ledgerEqualsStock = async (label: string) => {
    const batches = await BatchModel.find({ shopId: shop1 }).lean();
    let bad = 0;
    for (const b of batches) {
      const [s] = await MovementModel.aggregate<{ q: number }>([{ $match: { shopId: b.shopId, batchId: b._id } }, { $group: { _id: null, q: { $sum: '$quantity' } } }]);
      if ((s?.q ?? 0) !== b.quantity) bad++;
    }
    check(`${label}: movements sum = quantity on all ${String(batches.length)} batches`, bad === 0 && batches.length > 0, `${String(bad)} off`);
  };

  section('1. Suppliers');
  const supBody = (over: Record<string, unknown> = {}) => ({ name: 'Sharma Distributors', contactPerson: 'Anil Sharma', phone: '98311 22334', email: 'orders@sharma.test', gstin: '19ABCDE1234F1Z5', drugLicense: 'WB/KOL/20B/1189', creditDays: 30, address: 'Bagri Market, Kolkata', ...over });
  const s1 = await owner.post('/suppliers', supBody());
  check('add Sharma Distributors → 201', s1.status === 201 && data<Supplier>(s1).code === 'SD', code(s1));
  const sharma = data<Supplier>(s1).id;
  check('same name, other case → 422 on name', (await owner.post('/suppliers', supBody({ name: 'SHARMA distributors' }))).status === 422);
  check('bad GSTIN → 422', (await owner.post('/suppliers', supBody({ name: 'X1', gstin: '19ABC' }))).status === 422);
  check('bad phone → 422', (await owner.post('/suppliers', supBody({ name: 'X2', phone: '123' }))).status === 422);
  check('unknown field → 422', (await owner.post('/suppliers', supBody({ name: 'X3', payableBalance: -500 }))).status === 422);
  const gupta = data<Supplier>(await owner.post('/suppliers', supBody({ name: 'Gupta Pharma', gstin: '', phone: '98311 99887', creditDays: 15 }))).id;
  const sum0 = data<{ suppliers: number; totalDue: number }>(await owner.get('/suppliers/summary'));
  check('summary: 2 suppliers, nothing due', sum0.suppliers === 2 && sum0.totalDue === 0);

  section('2. PLAN §13 invoice — the server does the arithmetic');
  const line = (over: Record<string, unknown>) => ({ productId: dolo, batchNumber: 'DL2409', expiry: '2027-08', quantity: 30, freeQuantity: 2, unit: 'STRIP', rate: 2340, discountPercent: 0, mrp: 3350, gstRate: 12, rack: '', ...over });
  const purchase = (over: Record<string, unknown> = {}) => ({
    clientRequestId: randomUUID(),
    supplierId: sharma,
    invoiceNumber: 'SD/26/1189',
    invoiceDate: isoDay(-20),
    lines: [line({}), line({ productId: amox, batchNumber: 'AM5512', expiry: '2028-03', quantity: 20, freeQuantity: 0, rate: 6800, discountPercent: 5, mrp: 9200 })],
    ...over,
  });
  const firstBody = { ...purchase(), grandTotal: 1 };
  const r1 = await owner.post('/purchases', firstBody);
  const p1 = data<Saved>(r1);
  check(`first purchase is PUR-${fy}-0001`, r1.status === 201 && p1.purchaseNumber === `PUR-${fy}-0001`, code(r1));
  check('client total ₹0.01 ignored → server total ₹2,233', p1.grandTotal === 223_300, String(p1.grandTotal));
  const d1 = data<Purchase>(await owner.get(`/purchases/${p1.id}`));
  check('subtotal 2,062 · discount 68 · taxable 1,994', d1.subtotal === 206_200 && d1.totalDiscount === 6800 && d1.taxableAmount === 199_400);
  check('CGST 119.64 + SGST 119.64 · round off −0.28', d1.cgst === 11_964 && d1.sgst === 11_964 && d1.roundOff === -28);
  check('due date = invoice date + 30 credit days', new Date(d1.dueDate).getTime() - new Date(d1.invoiceDate).getTime() === 30 * 86_400_000);
  const dl = d1.lines[0];
  check('Dolo line: (30 + 2 free) × 15 = 480 tablets, landing ₹21.94 a strip, 146 paise a tablet', dl?.quantityInBase === 480 && dl.landingPerUnit === 2194 && dl.costPerBaseUnit === 146, JSON.stringify(dl));
  const b1 = await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL2409' }).lean();
  check('batch DL2409 on the shelf: 480, 30 free, supplier + purchase stamped', b1?.quantity === 480 && b1.freeQuantity === 30 && String(b1.supplierId) === sharma && String(b1.purchaseId) === p1.id && b1.source === 'purchase');
  check('batch took the product default rack', b1?.rack === 'A-2-1');
  const mv = await MovementModel.findOne({ shopId: shop1, batchId: b1?._id }).lean();
  check('ledger entry PURCHASE +480 with the purchase number', mv?.type === 'PURCHASE' && mv.quantity === 480 && mv.refNumber === p1.purchaseNumber && String(mv.refId) === p1.id);
  const sh1 = data<Supplier>(await owner.get(`/suppliers/${sharma}`));
  check('supplier owes ₹2,233 (unpaid)', sh1.payableBalance === 223_300 && d1.paymentStatus === 'unpaid' && d1.dueAmount === 223_300);
  const prod = data<{ stock: { sellable: number } }>(await owner.get(`/products/${dolo}`));
  check('Dolo stock went up to 480', prod.stock.sellable === 480);
  const again = await owner.post('/purchases', firstBody);
  check('same request again → 200, same purchase, nothing doubled', again.status === 200 && data<Saved>(again).id === p1.id && (await PurchaseModel.countDocuments({ shopId: shop1 })) === 1 && (await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL2409' }).lean())?.quantity === 480, code(again));
  const dupInv = await owner.post('/purchases', purchase({ invoiceNumber: 'sd/26/1189' }));
  check('same invoice number (any case) from the same supplier → 409', dupInv.status === 409 && details(dupInv).reason === 'DUPLICATE_INVOICE', code(dupInv));
  const gFirst = await owner.post('/purchases', purchase({ supplierId: gupta, lines: [line({ productId: pan, batchNumber: 'PN6012', expiry: '2027-11', quantity: 10, freeQuantity: 1, rate: 11_800, mrp: 15_540 })] }));
  check('same invoice number from another supplier is fine', gFirst.status === 201, code(gFirst));
  await books('after the first invoices');

  section('3. Merge rule on purchase (PLAN §9)');
  const r2 = await owner.post('/purchases', purchase({ invoiceNumber: 'SD/26/1201', invoiceDate: isoDay(-10), lines: [line({ batchNumber: 'dl2409', quantity: 15, freeQuantity: 0, rate: 2300 })] }));
  const d2 = data<Purchase>(await owner.get(`/purchases/${data<Saved>(r2).id}`));
  check('same batch + expiry + MRP → merged into DL2409 (480 → 705)', r2.status === 201 && d2.lines[0]?.how === 'merged' && (await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL2409' }).lean())?.quantity === 705, code(r2));
  const bm = await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL2409' }).lean();
  check('merged landing cost is the weighted one: (480×146 + 225×153) ÷ 705 = 148', bm?.costPerBaseUnit === 148, String(bm?.costPerBaseUnit));
  const mrpBody = purchase({ invoiceNumber: 'SD/26/1202', invoiceDate: isoDay(-9), lines: [line({ productId: pan, batchNumber: 'PN1', expiry: '2027-11', quantity: 5, freeQuantity: 0, rate: 11_000, mrp: 15_540 }), line({ quantity: 15, freeQuantity: 0, mrp: 3500 })] });
  const clash = await owner.post('/purchases', mrpBody);
  const lines = details(clash).lines as { index: number }[] | undefined;
  check('same batch, other MRP → 409 MRP_DIFFERS naming line 2', clash.status === 409 && details(clash).reason === 'MRP_DIFFERS' && lines?.[0]?.index === 1, code(clash));
  check('…and nothing was written', (await BatchModel.countDocuments({ shopId: shop1, batchNumber: 'PN1' })) === 0 && (await PurchaseModel.countDocuments({ shopId: shop1, invoiceNumber: 'SD/26/1202' })) === 0);
  const mlines = mrpBody.lines as Record<string, unknown>[];
  const r3 = await owner.post('/purchases', { ...mrpBody, lines: [mlines[0], { ...mlines[1], mrpChoice: 'merge' }] });
  const d3 = data<Purchase>(await owner.get(`/purchases/${data<Saved>(r3).id}`));
  check('“merge” → old batch MRP becomes ₹35.00, recorded as an MRP change', r3.status === 201 && (await BatchModel.findOne({ shopId: shop1, batchNumber: 'DL2409' }).lean())?.mrp === 3500 && d3.mrpChanges.some((m) => m.from === 3350 && m.to === 3500), code(r3));
  const r4 = await owner.post('/purchases', purchase({ invoiceNumber: 'SD/26/1203', invoiceDate: isoDay(-8), lines: [line({ quantity: 10, freeQuantity: 0, mrp: 3600, mrpChoice: 'separate' })] }));
  check('“separate” → DL2409-A', r4.status === 201 && data<Purchase>(await owner.get(`/purchases/${data<Saved>(r4).id}`)).lines[0]?.batchNumber === 'DL2409-A', code(r4));

  section('4. Validation (SECURITY §6 B3)');
  const v = async (over: Record<string, unknown>, top: Record<string, unknown> = {}) => (await owner.post('/purchases', purchase({ invoiceNumber: `V-${randomUUID().slice(0, 6)}`, lines: [line({ batchNumber: 'VX1', ...over })], ...top })));
  const exp = await v({ expiry: '2025-01' });
  check('already-expired batch → 422 on the line', exp.status === 422 && JSON.stringify(exp.json).includes('body.lines.0'), code(exp));
  check('unit the product doesn’t have (BOTTLE) → 422', (await v({ unit: 'BOTTLE' })).status === 422);
  check('quantity 0 → 422', (await v({ quantity: 0 })).status === 422);
  check('fraction quantity → 422', (await v({ quantity: 1.5 })).status === 422);
  check('rate 0 → 422', (await v({ rate: 0 })).status === 422);
  check('rate in rupees (23.4) → 422', (await v({ rate: 23.4 })).status === 422);
  check('discount 120 % → 422', (await v({ discountPercent: 120 })).status === 422);
  check('discount with 3 decimals → 422', (await v({ discountPercent: 1.234 })).status === 422);
  check('GST 7 % → 422', (await v({ gstRate: 7 })).status === 422);
  check('same batch twice in one invoice → 422', (await owner.post('/purchases', purchase({ invoiceNumber: 'V-dup', lines: [line({ batchNumber: 'VX2' }), line({ batchNumber: 'vx2' })] }))).status === 422);
  check('paid more than the total → 422', (await v({}, { payment: { mode: 'CASH', amount: 99_999_999 } })).status === 422);
  check('invoice date next week → 422', (await v({}, { invoiceDate: isoDay(7) })).status === 422);
  check('due date before invoice date → 422', (await v({}, { invoiceDate: isoDay(-2), dueDate: isoDay(-5) })).status === 422);
  check('30 Feb → 422', (await v({}, { invoiceDate: '2026-02-30' })).status === 422);
  check('no lines → 422', (await v({}, { lines: [] })).status === 422);
  check('unknown supplier → 404', (await v({}, { supplierId: '64b000000000000000000000' })).status === 404);
  check('nothing from the rejected attempts reached stock', (await BatchModel.countDocuments({ shopId: shop1, batchNumberUpper: { $in: ['VX1', 'VX2'] } })) === 0);

  section('5. Payments — FIFO, this invoice first, advance');
  const before = data<Supplier>(await owner.get(`/suppliers/${sharma}`)).payableBalance;
  const r5 = await owner.post('/purchases', purchase({ invoiceNumber: 'SD/26/1250', invoiceDate: isoDay(-1), lines: [line({ productId: pan, batchNumber: 'PN7', expiry: '2027-12', quantity: 10, freeQuantity: 0, rate: 10_000, mrp: 15_540, gstRate: 12 })], payment: { mode: 'UPI', amount: 50_000, reference: 'UTR123' } }));
  const p5 = data<Saved>(r5);
  const d5 = data<Purchase>(await owner.get(`/purchases/${p5.id}`));
  check('paid at save goes on this invoice, not the older ones', r5.status === 201 && d5.paidAmount === 50_000 && d5.paymentStatus === 'partial' && d5.allocations[0]?.kind === 'payment' && p5.paymentNumber === `PAY-${fy}-0001`, code(r5));
  check('older invoice untouched', data<Purchase>(await owner.get(`/purchases/${p1.id}`)).paidAmount === 0);
  check('balance went up by total − paid', data<Supplier>(await owner.get(`/suppliers/${sharma}`)).payableBalance === before + p5.grandTotal - 50_000);
  const pay = (amount: number, over: Record<string, unknown> = {}) => owner.post(`/suppliers/${sharma}/payments`, { clientRequestId: randomUUID(), amount, mode: 'NEFT', reference: 'UTR9', ...over });
  const openInv = data<{ id: string; dueAmount: number }[]>(await owner.get(`/suppliers/${sharma}/open-invoices`));
  check('open invoices: oldest first, dues add up to the balance', openInv[0]?.id === p1.id && openInv.reduce((a, x) => a + x.dueAmount, 0) === data<Supplier>(await owner.get(`/suppliers/${sharma}`)).payableBalance);
  const pr = await pay(300_000);
  const pd = data<{ applied: { purchaseId: string; amount: number }[]; advanceAdded: number }>(pr);
  check('₹3,000 paid → oldest invoice first (PUR-0001 fully), then the next', pr.status === 201 && pd.applied[0]?.purchaseId === p1.id && pd.applied[0].amount === 223_300 && pd.applied.length >= 2, code(pr));
  const d1b = data<Purchase>(await owner.get(`/purchases/${p1.id}`));
  check('PUR-0001 now paid', d1b.paymentStatus === 'paid' && d1b.dueAmount === 0);
  await books('after payments');
  const owed = data<Supplier>(await owner.get(`/suppliers/${sharma}`)).payableBalance;
  const over = await pay(owed + 100_000, { mode: 'CASH', fromDrawer: false });
  check('pay ₹1,000 more than due → that ₹1,000 kept as advance', over.status === 201 && data<{ advanceAdded: number }>(over).advanceAdded === 100_000, code(over));
  const shAdv = data<Supplier>(await owner.get(`/suppliers/${sharma}`));
  check('supplier shows −₹1,000 (advance with them)', shAdv.payableBalance === -100_000 && shAdv.advance === 100_000);
  const r6 = await owner.post('/purchases', purchase({ invoiceNumber: 'SD/26/1300', invoiceDate: isoDay(0), lines: [line({ productId: pan, batchNumber: 'PN8', expiry: '2027-12', quantity: 5, freeQuantity: 0, rate: 10_000, mrp: 15_540 })] }));
  const p6 = data<Saved>(r6);
  const d6 = data<Purchase>(await owner.get(`/purchases/${p6.id}`));
  check('next invoice (₹560) takes ₹560 of the advance first', r6.status === 201 && p6.fromAdvance === 56_000 && d6.allocations[0]?.kind === 'advance', JSON.stringify(d6.allocations));
  check('₹560 invoice − ₹1,000 advance → paid, ₹440 advance left', d6.paymentStatus === 'paid' && data<Supplier>(await owner.get(`/suppliers/${sharma}`)).advance === 44_000, `${String(d6.grandTotal)} ${JSON.stringify(d6.allocations)}`);
  const cashPay = await SupplierPaymentModel.find({ shopId: shop1, supplierId: sharma }).lean();
  check('cash from the owner’s pocket is not from the drawer', cashPay.some((x) => x.paymentMode === 'CASH' && !x.fromDrawer));
  check('payment 0 → 422', (await pay(0)).status === 422);
  check('payment mode “BITCOIN” → 422', (await pay(100, { mode: 'BITCOIN' })).status === 422);
  await books('after advance');

  section('6. Purchase return');
  const cand = data<{ id: string; batchNumber: string; daysLeft: number; costPerBaseUnit: number }[]>(await owner.get(`/purchase-returns/candidates?supplierId=${sharma}`));
  check('candidates: Sharma’s batches, nearest expiry first', cand.length >= 3 && cand.every((c, i) => i === 0 || (cand[i - 1]?.daysLeft ?? 0) <= c.daysLeft));
  check('Gupta’s batch is not a Sharma candidate', !cand.some((c) => c.batchNumber === 'PN6012'));
  const am = cand.find((c) => c.batchNumber === 'AM5512');
  const ret = (over: Record<string, unknown>) => owner.post('/purchase-returns', { clientRequestId: randomUUID(), supplierId: sharma, reason: 'DAMAGED', lines: [{ batchId: am?.id, quantity: 20 }], ...over });
  const due0 = data<Supplier>(await owner.get(`/suppliers/${sharma}`));
  const rr = await ret({ purchaseId: p1.id });
  const rd = data<{ id: string; returnNumber: string; total: number }>(rr);
  check(`20 capsules back → PR-${fy}-0001, credit = 20 × ₹6.46 + 12 % GST`, rr.status === 201 && rd.returnNumber === `PR-${fy}-0001` && rd.total === 20 * 646 + Math.floor((20 * 646 * 12 + 50) / 100), code(rr));
  check('AM5512 down to 180', (await BatchModel.findOne({ shopId: shop1, batchNumber: 'AM5512' }).lean())?.quantity === 180);
  check('credit lowered what we owe (here: more advance)', data<Supplier>(await owner.get(`/suppliers/${sharma}`)).payableBalance === due0.payableBalance - rd.total);
  check('more than on the shelf → 409', (await ret({ lines: [{ batchId: am?.id, quantity: 9999 }] })).status === 409);
  const gb = await BatchModel.findOne({ shopId: shop1, batchNumber: 'PN6012' }).lean();
  check('Gupta’s batch to Sharma → 422', (await ret({ lines: [{ batchId: String(gb?._id), quantity: 1 }] })).status === 422);
  check('batch not on the named purchase → 422', (await ret({ purchaseId: p5.id })).status === 422);
  const settle = await owner.post(`/purchase-returns/${rd.id}/settle`, { creditNoteNumber: 'SD/CN/77' });
  check('mark settled with the credit note → 200', settle.status === 200, code(settle));
  check('settle twice → 409', (await owner.post(`/purchase-returns/${rd.id}/settle`, { creditNoteNumber: 'X' })).status === 409);
  const all = await ret({ lines: [{ batchId: am?.id, quantity: 180 }], reason: 'EXPIRY' });
  check('return all that is left → batch marked returned', all.status === 201 && (await BatchModel.findOne({ shopId: shop1, batchNumber: 'AM5512' }).lean())?.status === 'returned', code(all));
  const rl = data<{ returnNumber: string; status: string }[]>(await owner.get('/purchase-returns'));
  check('returns list: newest first, pending then settled', rl[0]?.returnNumber === `PR-${fy}-0002` && rl[0].status === 'pending' && rl[1]?.status === 'settled', JSON.stringify(rl.slice(0, 2)));
  await books('after returns');
  await ledgerEqualsStock('after returns');

  section('7. Cancel a purchase');
  const r7 = await owner.post('/purchases', purchase({ supplierId: gupta, invoiceNumber: 'GP/77', invoiceDate: isoDay(-3), lines: [line({ productId: pan, batchNumber: 'PNC1', expiry: '2027-10', quantity: 4, freeQuantity: 0, rate: 10_000, mrp: 15_540 })], payment: { mode: 'CASH', amount: 20_000, fromDrawer: true } }));
  const p7 = data<Saved>(r7);
  const gBefore = data<Supplier>(await owner.get(`/suppliers/${gupta}`));
  const keeperRoles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    const sent = await owner.post('/staff', { email, name: email.split('@')[0], roleId: keeperRoles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    const inv = data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? '';
    const ok = await c.post(`/invitations/${inv}/accept`, { name: email.split('@')[0] });
    if (sent.status !== 201 || ok.status !== 200) throw new Error(`invite ${key} failed: ${code(sent)} / ${code(ok)}`);
    c.shopId = shop1;
    return c;
  };
  const keeper = await invite('kamal@buy1.test', 'stockKeeper');
  check('stock keeper can’t cancel (no purchases: approve) → 403', (await keeper.post(`/purchases/${p7.id}/cancel`, { reason: 'Wrong supplier' })).status === 403);
  check('cancel needs a reason → 422', (await owner.post(`/purchases/${p7.id}/cancel`, { reason: '' })).status === 422);
  const cx = await owner.post(`/purchases/${p7.id}/cancel`, { reason: 'Entered against the wrong supplier' });
  check('owner cancels → 200, ₹200 paid becomes advance', cx.status === 200 && data<{ advanceLeft: number }>(cx).advanceLeft === 20_000, code(cx));
  const d7 = data<Purchase>(await owner.get(`/purchases/${p7.id}`));
  check('purchase stays in the list as cancelled, nothing due', d7.status === 'cancelled' && d7.dueAmount === 0 && !d7.canCancel);
  const bc = await BatchModel.findOne({ shopId: shop1, batchNumber: 'PNC1' }).lean();
  check('its batch is empty and marked returned', bc?.quantity === 0 && bc.status === 'returned');
  check('ledger has a PURCHASE_CANCEL −60', (await MovementModel.findOne({ shopId: shop1, batchId: bc?._id, type: 'PURCHASE_CANCEL' }).lean())?.quantity === -60);
  const gAfter = data<Supplier>(await owner.get(`/suppliers/${gupta}`));
  check('Gupta: the invoice leaves the balance', gAfter.payableBalance === gBefore.payableBalance - p7.grandTotal && gAfter.advance === 0);
  const gOld = data<Purchase>(await owner.get(`/purchases/${data<Saved>(gFirst).id}`));
  check('…and the ₹200 paid on it now pays the older open invoice', gOld.paidAmount === 20_000 && gOld.allocations.some((a) => a.kind === 'advance' && a.amount === 20_000), JSON.stringify(gOld.allocations));
  const gl = data<Ledger>(await owner.get(`/suppliers/${gupta}/ledger?from=2000-01-01`));
  check('Gupta ledger: invoice debit and a “Cancelled” credit row', gl.rows.some((r) => r.kind === 'Cancelled' && r.credit === p7.grandTotal));
  check('cancel twice → 409', (await owner.post(`/purchases/${p7.id}/cancel`, { reason: 'again please' })).status === 409);
  const p8 = data<Saved>(await owner.post('/purchases', purchase({ supplierId: gupta, invoiceNumber: 'GP/78', lines: [line({ productId: pan, batchNumber: 'PNC2', expiry: '2027-10', quantity: 4, freeQuantity: 0, rate: 10_000, mrp: 15_540 })] })));
  const pnc2 = await BatchModel.findOne({ shopId: shop1, batchNumber: 'PNC2' }).lean();
  await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'DAMAGE', reason: 'Dropped', lines: [{ batchId: String(pnc2?._id), quantity: 1 }] });
  const used = await owner.post(`/purchases/${p8.id}/cancel`, { reason: 'Changed my mind' });
  check('stock already used (1 tablet damaged) → 409 STOCK_USED', used.status === 409 && details(used).reason === 'STOCK_USED', code(used));
  check('a merged line blocks cancel too', !data<Purchase>(await owner.get(`/purchases/${data<Saved>(r2).id}`)).canCancel);
  const mergedCancel = await owner.post(`/purchases/${data<Saved>(r2).id}/cancel`, { reason: 'Try a merged one' });
  check('cancel of a purchase merged into an older batch → 409 STOCK_USED (stock is all there)', mergedCancel.status === 409 && details(mergedCancel).reason === 'STOCK_USED', code(mergedCancel));
  await books('after cancel');
  await ledgerEqualsStock('after cancel');

  section('8. Two at once');
  const twin = purchase({ invoiceNumber: 'RACE/1', lines: [line({ productId: pan, batchNumber: 'RC1', expiry: '2027-10', quantity: 1, freeQuantity: 0, rate: 10_000, mrp: 15_540 })] });
  const race = await Promise.all([owner.post('/purchases', twin), owner.post('/purchases', { ...twin, clientRequestId: randomUUID() })]);
  check('same invoice saved twice at once → one 201, one 409', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 1, race.map(code).join(' | '));
  check('…and the stock came in once', (await BatchModel.findOne({ shopId: shop1, batchNumber: 'RC1' }).lean())?.quantity === 15);
  const pays = await Promise.all([pay(1000), pay(2000), pay(3000)]);
  check('three payments at once → all saved', pays.every((r) => r.status === 201), pays.map(code).join(' | '));
  const last = await BatchModel.findOne({ shopId: shop1, batchNumber: 'RC1' }).lean();
  const rets = await Promise.all([0, 1, 2].map(() => owner.post('/purchase-returns', { clientRequestId: randomUUID(), supplierId: sharma, reason: 'DAMAGED', lines: [{ batchId: String(last?._id), quantity: 15 }] })));
  check('three returns of the last 15 tablets at once → exactly one', rets.filter((r) => r.status === 201).length === 1, rets.map((r) => r.status).join(','));
  await books('after the races');
  await ledgerEqualsStock('after the races');

  section('9. Who may do what');
  const cashier = await invite('sunita@buy1.test', 'cashier');
  const accountant = await invite('meera@buy1.test', 'accountant');
  check('cashier → purchases 403', (await cashier.get('/purchases')).status === 403);
  check('cashier → suppliers 403', (await cashier.get('/suppliers')).status === 403);
  check('cashier → new purchase 403', (await cashier.post('/purchases', purchase({ invoiceNumber: 'C1' }))).status === 403);
  check('cashier → payment 403', (await cashier.post(`/suppliers/${sharma}/payments`, { clientRequestId: randomUUID(), amount: 100, mode: 'CASH' })).status === 403);
  const kp = await keeper.post('/purchases', purchase({ invoiceNumber: 'K1', lines: [line({ productId: pan, batchNumber: 'K1', expiry: '2027-10', quantity: 1, freeQuantity: 0, rate: 10_000, mrp: 15_540 })] }));
  check('stock keeper can enter a purchase', kp.status === 201, code(kp));
  const pending = data<{ id: string; status: string }[]>(await owner.get('/purchase-returns?status=pending'))[0];
  check('stock keeper may settle a pending return (purchases: edit)', (await keeper.post(`/purchase-returns/${pending?.id ?? ''}/settle`, { creditNoteNumber: 'SD/CN/78' })).status === 200);
  check('cashier can’t settle → 403', (await cashier.post(`/purchase-returns/${rd.id}/settle`, { creditNoteNumber: 'X' })).status === 403);
  check('accountant can read purchases and ledgers', (await accountant.get('/purchases')).status === 200 && (await accountant.get(`/suppliers/${sharma}/ledger`)).status === 200);
  check('accountant → new purchase 403', (await accountant.post('/purchases', purchase({ invoiceNumber: 'A1' }))).status === 403);
  check('accountant → payment 403 (suppliers: edit, sandbox rule — open question)', (await accountant.post(`/suppliers/${sharma}/payments`, { clientRequestId: randomUUID(), amount: 100, mode: 'CASH' })).status === 403);

  section('10. Another shop sees nothing');
  const other = await h.signIn('sourav@buy2.test');
  const shop2 = data<{ id: string }>(await other.post('/shops', shopBody('Life Care Pharmacy'))).id;
  other.shopId = shop2;
  check('shop 2: shop 1 supplier → 404', (await other.get(`/suppliers/${sharma}`)).status === 404);
  check('shop 2: shop 1 ledger → 404', (await other.get(`/suppliers/${sharma}/ledger`)).status === 404);
  check('shop 2: shop 1 purchase → 404', (await other.get(`/purchases/${p1.id}`)).status === 404);
  check('shop 2: shop 1 purchase PDF → 404', (await other.get(`/purchases/${p1.id}/pdf`)).status === 404);
  check('shop 2: pay shop 1 supplier → 404', (await other.post(`/suppliers/${sharma}/payments`, { clientRequestId: randomUUID(), amount: 100, mode: 'CASH' })).status === 404);
  check('shop 2: purchase against shop 1 supplier → 404', (await other.post('/purchases', purchase({ invoiceNumber: 'X' }))).status === 404);
  check('shop 2: cancel shop 1 purchase → 404', (await other.post(`/purchases/${p1.id}/cancel`, { reason: 'steal it' })).status === 404);
  check('shop 2: settle shop 1 return → 404', (await other.post(`/purchase-returns/${rd.id}/settle`, { creditNoteNumber: 'X' })).status === 404);
  const s2 = data<Supplier>(await other.post('/suppliers', supBody()));
  check('shop 2 can use the same supplier name', s2.name === 'Sharma Distributors');
  check('shop 2: shop 1 product on a line → 422', (await other.post('/purchases', purchase({ supplierId: s2.id, invoiceNumber: 'X1' }))).status === 422);
  const tab2 = data<{ id: string; name: string }[]>(await other.get('/categories')).find((c) => c.name === 'Tablet')?.id ?? '';
  const crocin = data<{ id: string }>(await other.post('/products', { name: 'Crocin', company: 'GSK', salt: '', strength: '', categoryId: tab2, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const first2 = await other.post('/purchases', purchase({ supplierId: s2.id, invoiceNumber: 'LC/1', lines: [line({ productId: crocin, batchNumber: 'CR1' })] }));
  check(`shop 2 numbering starts at PUR-${fy}-0001 too`, data<Saved>(first2).purchaseNumber === `PUR-${fy}-0001`, code(first2));
  check('shop 2: shop 1 batch in a return → 404', (await other.post('/purchase-returns', { clientRequestId: randomUUID(), supplierId: s2.id, reason: 'DAMAGED', lines: [{ batchId: String(b1?._id), quantity: 1 }] })).status === 404);
  const sr = data<{ suppliers: unknown[]; medicines: unknown[] }>(await other.get('/search?q=sharma'));
  check('shop 2 search finds only its own Sharma', sr.suppliers.length === 1);

  section('11. Lists, tiles, search');
  const list = data<{ purchaseNumber: string; status: string }[]>(await owner.get('/purchases?limit=3'));
  const listAll = data<unknown[]>(await owner.get(`/purchases?supplierId=${gupta}`));
  check('purchase list pages (3) and filters by supplier', list.length === 3 && listAll.length >= 3);
  check('filter unpaid shows only active unpaid', data<{ paymentStatus: string; status: string }[]>(await owner.get('/purchases?paymentStatus=unpaid')).every((p) => p.paymentStatus === 'unpaid' && p.status === 'active'));
  const range = data<{ invoices: number; total: number; due: number; returns: number }>(await owner.get(`/purchases/summary?from=${isoDay(-30)}&to=${isoDay(0)}`));
  const activeSum = (await PurchaseModel.find({ shopId: shop1, status: 'active' }).lean()).reduce((a, p) => a + p.grandTotal, 0);
  check('range tiles: total = Σ active invoices, returns counted', range.total === activeSum && range.returns > 0, `${String(range.total)} vs ${String(activeSum)}`);
  const ss = data<{ totalDue: number; overdue: number; dueThisWeek: number }>(await owner.get('/suppliers/summary'));
  check('supplier tiles: due this week includes overdue', ss.dueThisWeek >= ss.overdue);
  const srch = data<{ medicines: { name: string }[]; batches: { batchNumber: string }[]; suppliers: unknown[]; purchases: { purchaseNumber: string }[] }>(await owner.get('/search?q=dl24'));
  check('search “dl24” finds the batches', srch.batches.some((b) => b.batchNumber === 'DL2409'));
  check('search a purchase number', data<{ purchases: unknown[] }>(await owner.get(`/search?q=PUR-${fy}-0001`)).purchases.length === 1);
  const cs = data<{ suppliers: unknown[]; purchases: unknown[]; medicines: unknown[] }>(await cashier.get(`/search?q=PUR-${fy}`));
  check('cashier search: no suppliers, no purchases', cs.suppliers.length === 0 && cs.purchases.length === 0 && data<{ suppliers: unknown[] }>(await cashier.get('/search?q=sharma')).suppliers.length === 0);
  const info = data<{ last: { rate: number; unit: string; mrp: number } | null; batches: { batchNumber: string }[] }>(await owner.get(`/purchases/line-info?productId=${dolo}`));
  check('line info pre-fills the last rate and MRP', info.last?.unit === 'STRIP' && info.batches.some((b) => b.batchNumber === 'DL2409'));
  const reorder = data<{ name: string; lastSupplier: { name: string } | null; lastRate?: unknown }[]>(await owner.get('/stock/reorder'));
  check('reorder shows the last supplier', reorder.some((r) => r.lastSupplier !== null));
  check('cashier reorder: no last rate', data<{ lastRate?: unknown }[]>(await cashier.get('/stock/reorder')).every((r) => r.lastRate === undefined));
  const rec = data<{ source: string; purchaseNumber: string | null; supplierName: string | null }[]>(await owner.get(`/products/${dolo}/received`));
  check('product “received”: every purchase incl. the merged one', rec.filter((r) => r.source === 'purchase').length >= 4 && rec.every((r) => r.purchaseNumber !== null));
  const prods = data<{ id: string; times: number }[]>(await owner.get(`/suppliers/${sharma}/products`));
  check('products supplied by Sharma', prods.some((p) => p.id === dolo));

  section('12. Buy list (short book)');
  const dm1 = await cashier.post('/demands', { productId: amox, qty: '2 strips', note: 'Mr Sen' });
  check('cashier notes a product → 201', dm1.status === 201, code(dm1));
  const dm2 = await cashier.post('/demands', { name: 'Zerodol SP', qty: '' });
  check('a name not in products, amount not decided → 201', dm2.status === 201 && data<{ productId: string | null }>(dm2).productId === null);
  check('empty name → 422', (await cashier.post('/demands', { name: '' })).status === 422);
  check('cashier can’t link to a product (products: create) → 403', (await cashier.post('/demands/link', { ids: [data<{ id: string }>(dm2).id], productId: pan })).status === 403);
  const ln = await owner.post('/demands/link', { ids: [data<{ id: string }>(dm2).id], productId: amox });
  check('owner links the name to a product', ln.status === 200 && data<{ linked: number }>(ln).linked === 1);
  const asked = data<{ id: string; asked: number }[]>(await owner.get('/stock/reorder'));
  check('reorder: Amoxyclav (out of stock) asked 2×', asked.find((r) => r.id === amox)?.asked === 2, JSON.stringify(asked.map((r) => [r.id === amox, r.asked])));
  check('clear → gone from the list', (await owner.post('/demands/clear', { ids: [data<{ id: string }>(dm1).id] })).status === 200 && !data<{ id: string }[]>(await owner.get('/demands')).some((d) => d.id === data<{ id: string }>(dm1).id));
  check('shop 2 sees none of shop 1’s list', data<unknown[]>(await other.get('/demands')).length === 0);

  section('13. Exports and photos');
  const pdf = await owner.get(`/purchases/${p1.id}/pdf`);
  check('purchase PDF', pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf' && pdf.text.startsWith('%PDF'), code(pdf));
  const lp = await owner.get(`/suppliers/${sharma}/ledger/pdf`);
  check('ledger PDF', lp.status === 200 && lp.text.startsWith('%PDF'));
  check('reorder PDF for one supplier', (await owner.get(`/stock/reorder/pdf?supplierId=${sharma}`)).text.startsWith('%PDF'));
  const xl = await owner.get('/products/export');
  check('products Excel (owner)', xl.status === 200 && xl.text.startsWith('PK') && (xl.headers.get('content-disposition') ?? '').includes('Products.xlsx'));
  check('cashier → products export 403 (products: export)', (await cashier.get('/products/export')).status === 403);
  check('movements Excel', (await owner.get('/stock/movements/export')).text.startsWith('PK'));
  check('cashier → movements export 403', (await cashier.get('/stock/movements/export')).status === 403);
  let small = Buffer.alloc(0);
  for (const q of [70, 50, 35, 20]) {
    small = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#888', noise: { type: 'gaussian', mean: 128, sigma: 12 } } }).jpeg({ quality: q }).withExif({ IFD0: { Copyright: 'gps-secret-22.57N' } }).toBuffer();
    if (small.length < 590 * 1024) break;
  }
  check('test photo is a real 2400 × 1800 JPEG under 590 KB', small.length < 590 * 1024, String(small.length));
  const ph = await owner.post(`/purchases/${p1.id}/photo`, { photo: `data:image/jpeg;base64,${small.toString('base64')}` });
  check('invoice photo attached', ph.status === 200, code(ph));
  const att = await AttachmentModel.findOne({ shopId: shop1, ownerType: 'Purchase' }).lean();
  const ab = Buffer.from((att?.data as unknown as { buffer: Uint8Array }).buffer);
  const am2 = await sharp(ab).metadata();
  check('stored as WebP ≤ 1600 px, ≤ 400 KB, EXIF gone', am2.format === 'webp' && Math.max(am2.width, am2.height) <= 1600 && ab.length <= 400 * 1024 && !ab.includes('gps-secret'), `${String(am2.width)} ${String(ab.length)}`);
  check('detail says it has a photo; GET returns it', data<Purchase>(await owner.get(`/purchases/${p1.id}`)).hasPhoto && data<{ dataUrl: string }>(await owner.get(`/purchases/${p1.id}/photo`)).dataUrl.startsWith('data:image/webp'));
  check('text pretending to be JPEG → 422', (await owner.post(`/purchases/${p1.id}/photo`, { photo: `data:image/jpeg;base64,${Buffer.from('hello').toString('base64')}` })).status === 422);
  check('over 850 KB body → 413', (await owner.post(`/purchases/${p1.id}/photo`, { photo: `data:image/jpeg;base64,${'A'.repeat(900_000)}` })).status === 413);
  check('other endpoints still refuse bodies over 100 KB', (await owner.post('/demands', { name: 'x'.repeat(120_000) })).status === 413);
  check('shop 2 can’t read shop 1’s invoice photo', (await other.get(`/purchases/${p1.id}/photo`)).status === 404);
  const adj = data<{ id: string }>(await owner.post('/stock/adjustments', { clientRequestId: randomUUID(), type: 'DAMAGE', reason: 'Wet box', lines: [{ batchId: String(bm?._id), quantity: 1 }] }));
  check('damage adjustment photo', (await owner.post(`/stock/adjustments/${adj.id}/photo`, { photo: `data:image/jpeg;base64,${small.toString('base64')}` })).status === 200);
  check('cashier can’t attach a damage photo → 403', (await cashier.post(`/stock/adjustments/${adj.id}/photo`, { photo: 'data:image/jpeg;base64,AA==' })).status === 403);

  section('14. Expiry centre knows the supplier');
  const soon = new Date(Date.now() + IST + 40 * 86_400_000).toISOString().slice(0, 7);
  await owner.post('/purchases', purchase({ invoiceNumber: 'SOON/1', lines: [line({ productId: pan, batchNumber: 'SOON1', expiry: soon, quantity: 1, freeQuantity: 0, rate: 10_000, mrp: 15_540 })] }));
  await owner.post('/stock/opening', { clientRequestId: randomUUID(), productId: pan, batchNumber: 'OPEN1', expiry: soon, quantity: 15, mrp: 15_540, purchaseRate: 10_000, rack: '' });
  const items = (await Promise.all(['d30', 'd60', 'd90'].map(async (b) => data<{ items: { batchNumber: string; supplierName: string | null; source: string }[] }>(await owner.get(`/stock/expiry?bucket=${b}`)).items))).flat();
  check('expiring purchase batch names its supplier', items.find((i) => i.batchNumber === 'SOON1')?.supplierName === 'Sharma Distributors', JSON.stringify(items));
  check('expiring opening batch has no supplier', items.find((i) => i.batchNumber === 'OPEN1')?.supplierName === null);

  const aging = data<{ months: string[]; basis: string; series: { name: string; data: number[] }[] }>(await owner.get('/stock/expiry/aging'));
  const soonValue = (await BatchModel.find({ shopId: shop1, batchNumber: { $in: ['SOON1', 'OPEN1'] } }).lean()).reduce((a, b) => a + b.quantity * b.costPerBaseUnit, 0);
  const soonIdx = aging.months.indexOf(soon);
  check('expiry aging: 6 months, the expiring Pan batches counted at cost in their month', aging.months.length === 6 && aging.basis === 'cost' && soonIdx > 0 && aging.series.reduce((a, s) => a + (s.data[soonIdx] ?? 0), 0) >= soonValue && soonValue > 0, JSON.stringify(aging));
  check('cashier aging is at MRP', data<{ basis: string }>(await cashier.get('/stock/expiry/aging')).basis === 'mrp');
  section('15. Not only medicines: no-expiry devices, lots for non-medicines, lowest price (D57, D59)');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  check('new shops get Chocolate & snacks, Drinks, Baby care, Personal care, Nutrition', ['Chocolate & snacks', 'Drinks', 'Baby care', 'Personal care', 'Nutrition'].every((n) => cats.some((c) => c.name === n)));
  const catOf = (n: string) => cats.find((c) => c.name === n)?.id ?? '';
  const piece = { type: 'COUNT', base: 'PIECE', sale: 'PIECE', salePack: 1, purchase: 'BOX', purchasePack: 10, allowLooseSale: false };
  const bp = await mk(owner, 'Omron BP Monitor', piece, { company: 'Omron', categoryId: catOf('Device'), scheduleType: 'NON_DRUG', hsnCode: '9018', gstRate: 18, defaultRack: 'ST-B-2', noExpiry: true, reorderLevel: 1, reorderQuantity: 2 });
  const bar = { type: 'COUNT', base: 'BAR', sale: 'BAR', salePack: 1, purchase: 'BOX', purchasePack: 24, allowLooseSale: false };
  const silk = await mk(owner, 'Dairy Milk Silk 60 g', bar, { company: 'Mondelez', categoryId: catOf('Chocolate & snacks'), scheduleType: 'NON_DRUG', hsnCode: '1806', gstRate: 5, defaultRack: 'CS-4', reorderLevel: 5, reorderQuantity: 24 });
  const can = { type: 'COUNT', base: 'CAN', sale: 'CAN', salePack: 1, purchase: 'CASE', purchasePack: 24, allowLooseSale: false };
  const bull = await mk(owner, 'Red Bull 250 ml', can, { company: 'Red Bull', categoryId: catOf('Drinks'), scheduleType: 'NON_DRUG', hsnCode: '2202', gstRate: 40, defaultRack: 'CS-5', reorderLevel: 6, reorderQuantity: 24 });
  check('device, chocolate (BAR) and drink (CAN by the CASE, 40 % GST) are products', Boolean(bp && silk && bull));
  check('device detail says noExpiry', data<{ noExpiry: boolean }>(await owner.get(`/products/${bp}`)).noExpiry);
  const lineInfo = data<{ product: { noExpiry: boolean; scheduleType: string } }>(await owner.get(`/purchases/line-info?productId=${bp}`));
  check('purchase line info tells the screen: no expiry, non-drug', lineInfo.product.noExpiry && lineInfo.product.scheduleType === 'NON_DRUG', JSON.stringify(lineInfo.product));
  const invDay = isoDay(-2);
  const lot = `LOT-${invDay.slice(2).replace(/-/g, '')}`;
  const nx = await owner.post(
    '/purchases',
    purchase({
      invoiceNumber: 'NX/1',
      invoiceDate: invDay,
      lines: [
        { productId: bp, batchNumber: '', quantity: 2, freeQuantity: 0, unit: 'PIECE', rate: 150_000, discountPercent: 0, mrp: 249_000, gstRate: 18, rack: '' },
        { productId: silk, batchNumber: '', expiry: '2027-03', quantity: 1, freeQuantity: 0, unit: 'BOX', rate: 160_000, discountPercent: 0, mrp: 9000, minPrice: 8000, gstRate: 5, rack: '' },
        { productId: bull, batchNumber: 'RB77', expiry: '2027-01', quantity: 1, freeQuantity: 0, unit: 'CASE', rate: 210_000, discountPercent: 0, mrp: 12_500, gstRate: 40, rack: '' },
      ],
    }),
  );
  check('device without batch or expiry, chocolate without batch → 201', nx.status === 201, code(nx));
  const bpBatch = await BatchModel.findOne({ shopId: shop1, productId: bp }).lean();
  check(`device batch is ${lot}, stored with the far-future date`, bpBatch?.batchNumber === lot && bpBatch.expiryDate.getUTCFullYear() === 9999, String(bpBatch?.batchNumber));
  const silkBatch = await BatchModel.findOne({ shopId: shop1, productId: silk }).lean();
  check('chocolate got the same day lot, its own expiry and the lowest price', silkBatch?.batchNumber === lot && silkBatch.expiryDate.getUTCFullYear() === 2027 && silkBatch.minPrice === 8000);
  check('drink bought by the case: 24 cans on the shelf', (await BatchModel.findOne({ shopId: shop1, productId: bull }).lean())?.quantity === 24);
  const nxd = data<{ lines: { productName: string; expiryDate: string | null }[] }>(await owner.get(`/purchases/${data<Saved>(nx).id}`));
  check('API sends the device expiry as null, never 9999', nxd.lines.find((l) => l.productName === 'Omron BP Monitor')?.expiryDate === null && !JSON.stringify(nxd).includes('9999'), JSON.stringify(nxd.lines));
  const bpb = data<{ id: string; expiryDate: string | null; daysLeft: number | null; bucket: string }[]>(await owner.get(`/products/${bp}/batches`));
  check('device batch: expiry null, days left null, sellable', bpb[0]?.expiryDate === null && bpb[0].daysLeft === null && bpb[0].bucket === 'sellable', JSON.stringify(bpb));
  const bpp = data<{ stock: { sellable: number; nextExpiry: string | null } }>(await owner.get(`/products/${bp}`));
  check('device stock 2, next expiry null', bpp.stock.sellable === 2 && bpp.stock.nextExpiry === null, JSON.stringify(bpp.stock));
  check('purchase PDF prints a device line', (await owner.get(`/purchases/${data<Saved>(nx).id}/pdf`)).status === 200);
  const v2 = async (l: Record<string, unknown>) => owner.post('/purchases', purchase({ invoiceNumber: `NX-${randomUUID().slice(0, 6)}`, lines: [{ quantity: 1, freeQuantity: 0, discountPercent: 0, rack: '', ...l }] }));
  const noExp = await v2({ productId: silk, batchNumber: 'S1', unit: 'BAR', rate: 7000, mrp: 9000, gstRate: 5 });
  check('chocolate without expiry → 422 on the line (it does expire)', noExp.status === 422 && JSON.stringify(noExp.json).includes('body.lines.0'), code(noExp));
  const noBatch = await v2({ productId: dolo, batchNumber: '', expiry: '2028-01', unit: 'STRIP', rate: 2340, mrp: 3350, gstRate: 12 });
  check('medicine without batch number → 422 (only non-medicines get a lot)', noBatch.status === 422 && JSON.stringify(noBatch.json).toLowerCase().includes('batch number is required'), code(noBatch));
  const op = await owner.post('/stock/opening', { clientRequestId: randomUUID(), productId: bp, batchNumber: '', quantity: 1, mrp: 249_000, purchaseRate: 150_000, rack: '' });
  check('opening stock of a device without batch or expiry → saved', op.status === 201, code(op));
  check('opening of a medicine still needs expiry → 422', (await owner.post('/stock/opening', { clientRequestId: randomUUID(), productId: dolo, batchNumber: 'X9', quantity: 15, mrp: 3350, purchaseRate: 2340, rack: '' })).status === 422);
  const exAll = (await Promise.all(['expired', 'd30', 'd60', 'd90'].map(async (b) => data<{ items: { productName: string }[] }>(await owner.get(`/stock/expiry?bucket=${b}`)).items))).flat();
  check('expiry centre never lists the device', !exAll.some((i) => i.productName === 'Omron BP Monitor'));
  check('“expiring” product filter leaves the device out', !data<{ name: string }[]>(await owner.get('/products?expiring=true')).some((i) => i.name === 'Omron BP Monitor'));
  const editBody = { name: 'Omron BP Monitor', company: 'Omron', salt: '', strength: '', categoryId: catOf('Device'), scheduleType: 'NON_DRUG', storageType: 'NORMAL', hsnCode: '9018', gstRate: 18, units: piece, packSize: '', defaultRack: 'ST-B-2', reorderLevel: 1, reorderQuantity: 2 };
  const flip = await owner.put(`/products/${bp}`, { ...editBody, noExpiry: false, version: data<{ version: number }>(await owner.get(`/products/${bp}`)).version });
  check('“Has an expiry date” locked once stock exists → 409', flip.status === 409, code(flip));
  const fresh = await mk(owner, 'Dr Trust Thermometer', piece, { categoryId: catOf('Device'), scheduleType: 'NON_DRUG', hsnCode: '9025', gstRate: 18, noExpiry: true });
  const fv = data<{ version: number }>(await owner.get(`/products/${fresh}`)).version;
  check('…but free to change before any stock', (await owner.put(`/products/${fresh}`, { ...editBody, name: 'Dr Trust Thermometer', noExpiry: false, version: fv })).status === 200);

  const silkB = data<{ id: string; minPrice: number | null }[]>(await owner.get(`/products/${silk}/batches`))[0];
  const sid = silkB?.id ?? '';
  check('lowest price from the purchase line is on the batch (₹80 a bar)', silkB?.minPrice === 8000, JSON.stringify(silkB));
  const mp = await owner.patch(`/stock/batches/${sid}/min-price`, { minPrice: 8500 });
  check('owner sets the lowest price → 200, audited', mp.status === 200 && (await AuditLogModel.exists({ shopId: shop1, text: /lowest price of Dairy Milk Silk 60 g/ })) !== null, code(mp));
  check('cashier can’t change it → 403', (await cashier.patch(`/stock/batches/${sid}/min-price`, { minPrice: 100 })).status === 403);
  check('negative or rupees → 422', (await owner.patch(`/stock/batches/${sid}/min-price`, { minPrice: -1 })).status === 422 && (await owner.patch(`/stock/batches/${sid}/min-price`, { minPrice: 80.5 })).status === 422);
  check('null removes it', (await owner.patch(`/stock/batches/${sid}/min-price`, { minPrice: null })).status === 200 && (await BatchModel.findOne({ shopId: shop1, _id: sid }).lean())?.minPrice === undefined);
  check('shop 2 can’t touch shop 1’s batch → 404', (await other.patch(`/stock/batches/${sid}/min-price`, { minPrice: 100 })).status === 404);
  check('line info carries the last lowest price (removed → null)', data<{ lastMinPrice: number | null }>(await owner.get(`/purchases/line-info?productId=${silk}`)).lastMinPrice === null);

  await books('end');
  await ledgerEqualsStock('end');
  await h.close();
  finish();
}

main().catch(crash);
