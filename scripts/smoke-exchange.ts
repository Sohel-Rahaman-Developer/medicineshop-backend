// Exchange checks: a credit note pays a new bill — pay the difference, get the rest back, or keep it on the note.
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
const units10 = { type: 'COUNT', base: 'CAPSULE', sale: 'STRIP', salePack: 10, purchase: 'STRIP', purchasePack: 1, allowLooseSale: true };

interface Note { id: string; creditNoteNumber: string; creditLeft: number; uses: { billNumber: string; amount: number; back: number; backMode: string | null }[] }
interface Saved { id: string; billNumber: string; noteUsed: number; noteBack: number; noteLeft: number }

async function main() {
  const h = await startHarness();
  const { SaleReturnModel } = await import('../src/modules/sales/sale-return.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');

  const c = await h.signIn('rohit@exchange.test');
  c.shopId = data<{ id: string }>(await c.post('/shops', shopBody('Exchange Medical Store'))).id;
  const shop = c.shopId;
  const cats = data<{ id: string; name: string }[]>(await c.get('/categories'));
  const mk = async (name: string, units: Record<string, unknown>) =>
    data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: cats.find((x) => x.name === 'Tablet')?.id, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const dolo = await mk('Dolo 650 Tablet', units15);
  const amox = await mk('Augmentin 625', units10);
  await c.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: dolo, batchNumber: 'DL1', expiry: '2028-12', quantity: 600, mrp: 3000, purchaseRate: 1900 });
  await c.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: amox, batchNumber: 'AM1', expiry: '2028-12', quantity: 100, mrp: 9200, purchaseRate: 6400 });

  const ok = async (what: string, p: Promise<Res>) => {
    const r = await p;
    if (r.status !== 200 && r.status !== 201) throw new Error(`${what}: ${code(r)}`);
    return r;
  };
  const sell = (productId: string, strips: number, over: Record<string, unknown>) => c.post('/sales', { clientRequestId: randomUUID(), items: [{ productId, quantity: strips, unit: 'STRIP' }], payments: [], ...over });
  // A Dolo bill paid in cash, then all of it back as a credit note.
  const noteOf = async (strips: number) => {
    const b = data<{ id: string }>(await ok('bill', sell(dolo, strips, { payments: [{ mode: 'CASH', amount: strips * 3000 }] })));
    return data<Note>(await ok('return', c.post('/sale-returns', { clientRequestId: randomUUID(), saleId: b.id, items: [{ line: 0, quantity: strips * 15, reason: 'Exchange' }], refundMode: 'CREDIT_NOTE' })));
  };
  const note = async (id: string) => data<Note>(await c.get(`/sale-returns/${id}`));

  section('1. The new medicine costs more: the customer pays the difference');
  const n1 = await noteOf(2);
  check('a credit note holds the whole refund: ₹60', n1.creditLeft === 6000, JSON.stringify(n1));
  const short = await sell(amox, 1, { creditNoteId: n1.id, payments: [{ mode: 'CASH', amount: 1000 }] });
  check('payments that don’t cover the rest → 422, names what is left', short.status === 422 && /credit note pays ₹60\.00, so ₹32\.00 is left/.test(short.json.error?.message ?? ''), code(short));
  const x1 = data<Saved>(await ok('exchange up', sell(amox, 1, { creditNoteId: n1.id, payments: [{ mode: 'CASH', amount: 3200 }], cashReceived: 5000 })));
  check('₹92 bill: ₹60 from the note + ₹32 cash', x1.noteUsed === 6000 && x1.noteBack === 0 && x1.noteLeft === 0, JSON.stringify(x1));
  const d1 = data<{ payments: { mode: string; amount: number; reference: string }[]; paidAmount: number; dueAmount: number; paymentStatus: string }>(await c.get(`/sales/${x1.id}`));
  check('the bill shows the credit note as a payment, fully paid', d1.payments.some((p) => p.mode === 'CREDIT_NOTE' && p.amount === 6000 && p.reference === n1.creditNoteNumber) && d1.paidAmount === 9200 && d1.dueAmount === 0 && d1.paymentStatus === 'paid', JSON.stringify(d1));
  const u1 = await note(n1.id);
  check('the note is used up and says where', u1.creditLeft === 0 && u1.uses.length === 1 && u1.uses[0]?.billNumber === x1.billNumber && u1.uses[0].amount === 6000);
  const again = await sell(dolo, 1, { creditNoteId: n1.id, payments: [] });
  check('a used-up note can’t pay again → 409', again.status === 409, code(again));

  section('2. The new medicine costs less: the shop gives the rest back');
  const n2 = await noteOf(5);
  const x2 = data<Saved>(await ok('exchange down', sell(amox, 1, { creditNoteId: n2.id, noteBack: 'CASH' })));
  check('₹150 note, ₹92 bill: ₹58 back in cash, nothing left on the note', x2.noteUsed === 9200 && x2.noteBack === 5800 && x2.noteLeft === 0, JSON.stringify(x2));
  check('the bill keeps what was given back', data<{ noteBack: { amount: number; mode: string } | null }>(await c.get(`/sales/${x2.id}`)).noteBack?.amount === 5800);
  check('audit: “credit note … ₹58.00 given back by cash”', (await AuditLogModel.countDocuments({ shopId: shop, entityName: x2.billNumber, text: /exchange: credit note .* paid ₹92\.00, ₹58\.00 given back by cash/ })) === 1);

  section('3. Keep the rest on the note; a cancelled bill puts it back');
  const n3 = await noteOf(3);
  const x3 = data<Saved>(await ok('keep the rest', sell(dolo, 1, { creditNoteId: n3.id })));
  check('₹90 note, ₹30 bill, nothing given back: ₹60 stays on it', x3.noteUsed === 3000 && x3.noteBack === 0 && x3.noteLeft === 6000, JSON.stringify(x3));
  const x4 = data<Saved>(await ok('spend the rest', sell(dolo, 2, { creditNoteId: n3.id })));
  check('a later bill spends the ₹60 left', x4.noteUsed === 6000 && x4.noteLeft === 0);
  await ok('cancel', c.post(`/sales/${x4.id}/cancel`, { reason: 'Wrong item' }));
  check('cancelling that bill puts ₹60 back on the note', (await note(n3.id)).creditLeft === 6000);
  const sale = data<{ returns: { id: string; creditLeft: number }[] }>(await c.get(`/sales/${(await SaleReturnModel.findOne({ shopId: shop, _id: n3.id }).lean())?.saleId.toString() ?? ''}`));
  check('the old bill’s returns show what is left on the note', sale.returns[0]?.creditLeft === 6000);

  section('4. Notes from before exchanges, and wrong ones');
  const n4 = await noteOf(1);
  await SaleReturnModel.updateOne({ shopId: shop, _id: n4.id }, { $unset: { creditLeft: 1 } });
  check('an old note (no balance kept) still holds its whole ₹30', (await note(n4.id)).creditLeft === 3000);
  const x5 = data<Saved>(await ok('spend an old note', sell(dolo, 1, { creditNoteId: n4.id })));
  check('…and pays a bill like any other', x5.noteUsed === 3000 && (await note(n4.id)).creditLeft === 0);
  const cashBill = data<{ id: string }>(await ok('bill', sell(dolo, 1, { payments: [{ mode: 'CASH', amount: 3000 }] })));
  const cashBack = data<{ id: string }>(await ok('cash return', c.post('/sale-returns', { clientRequestId: randomUUID(), saleId: cashBill.id, items: [{ line: 0, quantity: 15, reason: 'Exchange' }], refundMode: 'CASH' })));
  check('a cash refund is not a credit note → 404', (await sell(dolo, 1, { creditNoteId: cashBack.id })).status === 404);
  check('an unknown note → 404', (await sell(dolo, 1, { creditNoteId: '64b000000000000000000000' })).status === 404);
  check('giving back by card → 422', (await sell(dolo, 1, { creditNoteId: n3.id, noteBack: 'CARD' })).status === 422);
  const other = await h.signIn('owner@exchange2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Other Pharmacy'))).id;
  const otherCat = data<{ id: string; name: string }[]>(await other.get('/categories')).find((x) => x.name === 'Tablet')?.id;
  const theirs = data<{ id: string }>(await other.post('/products', { name: 'Dolo 650 Tablet', company: 'Micro Labs', salt: 'Paracetamol', strength: '', categoryId: otherCat, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  await other.post('/stock/opening', { clientRequestId: randomUUID(), rack: '', productId: theirs, batchNumber: 'OT1', expiry: '2028-12', quantity: 30, mrp: 3000, purchaseRate: 1900 });
  const stolen = await other.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: theirs, quantity: 1, unit: 'STRIP' }], payments: [], creditNoteId: n3.id });
  check('another shop can’t spend this shop’s note → 404', stolen.status === 404, code(stolen));

  section('5. The drawer');
  const day = data<{ cash: { cashSales: number; refunds: number; cancelled: number } | null }>(await c.get('/day-close')).cash;
  // Cash in: bills ₹60 + ₹150 + ₹90 + ₹30 + ₹30 sold for notes and the refund, + ₹32 on the first exchange.
  check('cash sales ₹392: the notes’ bills and the ₹32 difference, never the note itself', day?.cashSales === 39_200, JSON.stringify(day));
  check('out: ₹58 given back on the exchange + ₹30 cash refund', day?.refunds === 8800 && day.cancelled === 0, JSON.stringify(day));

  await h.close();
  finish();
}

main().catch(crash);
