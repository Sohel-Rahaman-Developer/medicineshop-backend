// v1.25.1 checks: stock sent between the shops of one owner — out of the sender at once, into the receiver on Receive;
// same GSTIN → challan without tax, another GSTIN → tax invoice at cost; cancel before receipt puts it back; nobody else sees it.
import { randomUUID } from 'node:crypto';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const units = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };

const shopBody = (name: string, gstin?: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE', ...(gstin ? { gstin } : {}) },
  termsVersion: '2026-10',
  agree: true,
});
const branch = (name: string, state: string, city: string, pincode: string, billPrefix: string, gst: Record<string, string>) => ({ name, address: { line1: 'Main Road', city, state, pincode }, phone: '033 2321 5566', drugLicenseNumber: 'DL/2025/1102', drugLicenseExpiry: '2030-08', billPrefix, ...gst });

interface Target { id: string; name: string; kind: string }
interface Tr { id: string; number: string; kind: string; status: string; value: number; tax: number; total: number; incoming: boolean }
interface List { incoming: Tr[]; outgoing: Tr[]; shops: Target[] }

async function main() {
  const h = await startHarness();
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { MovementModel } = await import('../src/modules/stock/movement.model.js');
  const { ProductModel } = await import('../src/modules/products/product.model.js');
  const { NotificationModel } = await import('../src/modules/notifications/notification.model.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@trf1.test');
  const mainId = data<{ id: string }>(await owner.post('/shops', shopBody('Krishna Medical', '19ABCDE1234F1Z5'))).id;
  owner.shopId = mainId;
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id;
  const mk = async (c: Client, name: string) => data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt: name, strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const stock = (c: Client, productId: string, batchNumber: string, quantity: number) => c.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId, batchNumber, expiry: '2028-12', quantity, mrp: 3000, purchaseRate: 1950 });
  const dolo = await mk(owner, 'Dolo 650 Tablet');
  await stock(owner, dolo, 'DL1', 150);
  const slt = data<{ id: string }>(await owner.post('/branches', branch('Krishna Salt Lake', 'West Bengal', 'Salt Lake', '700064', 'SLT', { gst: 'main' }))).id;
  const pat = data<{ id: string }>(await owner.post('/branches', branch('Krishna Patna', 'Bihar', 'Patna', '800001', 'PAT', { gst: 'own', gstin: '10ABCDE1234F1Z7' }))).id;
  const zifi = await mk(owner, 'Zifi 200 Tablet');
  await stock(owner, zifi, 'ZF1', 60);
  const dl1 = await BatchModel.findOne({ shopId: mainId, batchNumber: 'DL1' }).lean();
  const zf1 = await BatchModel.findOne({ shopId: mainId, batchNumber: 'ZF1' }).lean();
  const qtyOf = async (shopId: string, batchNumber: string) => (await BatchModel.findOne({ shopId, batchNumber }).lean())?.quantity ?? null;
  const at = async (shopId: string) => {
    const c = await h.signIn('rohit@trf1.test');
    c.shopId = shopId;
    return c;
  };
  const sltC = await at(slt);
  const patC = await at(pat);
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'sunita@trf1.test', name: 'Sunita', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('sunita@trf1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Sunita' });
  cashier.shopId = mainId;

  section('1. Same GSTIN: a challan, no tax');
  const list0 = data<List>(await owner.get('/transfers'));
  check('the other two shops; Salt Lake gets a challan, Patna an invoice', list0.shops.length === 2 && list0.shops.find((s) => s.id === slt)?.kind === 'challan' && list0.shops.find((s) => s.id === pat)?.kind === 'invoice', JSON.stringify(list0.shops));
  const key = randomUUID();
  const body = { clientRequestId: key, toShopId: slt, lines: [{ batchId: String(dl1?._id), quantity: 30 }] };
  check('a cashier can’t send stock → 403', (await cashier.post('/transfers', { ...body, clientRequestId: randomUUID() })).status === 403);
  check('to this same shop → 422', (await owner.post('/transfers', { ...body, clientRequestId: randomUUID(), toShopId: mainId })).status === 422);
  check('the same batch twice → 422', (await owner.post('/transfers', { ...body, clientRequestId: randomUUID(), lines: [...body.lines, ...body.lines] })).status === 422);
  check('more than the batch has → 409', (await owner.post('/transfers', { ...body, clientRequestId: randomUUID(), lines: [{ batchId: String(dl1?._id), quantity: 151 }] })).status === 409);
  const s1 = await owner.post('/transfers', body);
  const t1 = data<Tr>(s1);
  check('sent: TRF number, challan, ₹39 at cost (30 × ₹1.30), no tax', s1.status === 201 && /^TRF-\d{4}-\d{2}-0001$/.test(t1.number) && t1.kind === 'challan' && t1.value === 3900 && t1.tax === 0, code(s1));
  check('the stock left the main shop at once (150 → 120), as a transfer out', (await qtyOf(mainId, 'DL1')) === 120 && Boolean(await MovementModel.exists({ shopId: mainId, type: 'TRANSFER_OUT', quantity: -30 })));
  check('the same request again → the same transfer, no second 30', data<Tr>(await owner.post('/transfers', body)).number === t1.number && (await qtyOf(mainId, 'DL1')) === 120);
  check('Salt Lake hears of it in the bell', (await NotificationModel.countDocuments({ shopId: slt, type: 'STOCK_TRANSFER' })) === 1);
  check('…and sees it coming in; nothing added yet', data<List>(await sltC.get('/transfers')).incoming[0]?.status === 'sent' && (await qtyOf(slt, 'DL1')) === null);
  check('the main shop can’t receive its own transfer → 404', (await owner.post(`/transfers/${t1.id}/receive`)).status === 404);
  const r1 = await sltC.post(`/transfers/${t1.id}/receive`);
  const b1 = await BatchModel.findOne({ shopId: slt, batchNumber: 'DL1' }).lean();
  check('received: batch DL1 in Salt Lake with 30, the same cost, MRP and expiry', r1.status === 200 && b1?.quantity === 30 && b1.costPerBaseUnit === 130 && b1.mrp === 3000 && b1.expiryDate.getTime() === dl1?.expiryDate.getTime() && b1.source === 'transfer', code(r1));
  check('…a transfer in on its ledger', Boolean(await MovementModel.exists({ shopId: slt, type: 'TRANSFER_IN', quantity: 30, refNumber: t1.number })));
  check('receiving twice → 409', (await sltC.post(`/transfers/${t1.id}/receive`)).status === 409);
  check('a received transfer can’t be cancelled → 409', (await owner.post(`/transfers/${t1.id}/cancel`, { reason: 'Changed mind' })).status === 409);
  const c1 = await owner.raw('GET', `/transfers/${t1.id}/pdf`);
  check('the challan downloads for the sender', c1.status === 200 && c1.text.startsWith('%PDF'));
  check('…and for the receiver', (await sltC.raw('GET', `/transfers/${t1.id}/pdf`)).status === 200);

  section('2. Another GSTIN: a tax invoice; a medicine the branch doesn’t have yet');
  check('Patna doesn’t have Zifi yet', !(await ProductModel.exists({ shopId: pat, nameLower: 'zifi 200 tablet' })));
  const s2 = await owner.post('/transfers', { clientRequestId: randomUUID(), toShopId: pat, lines: [{ batchId: String(zf1?._id), quantity: 15 }], note: 'For the new counter' });
  const t2 = data<Tr>(s2);
  check('invoice: ₹19.50 at cost + 12% GST ₹2.34 = ₹21.84', s2.status === 201 && t2.kind === 'invoice' && t2.value === 1950 && t2.tax === 234 && t2.total === 2184, JSON.stringify(t2));
  check('Patna receives → Zifi is added there with stock 15', (await patC.post(`/transfers/${t2.id}/receive`)).status === 200 && (await qtyOf(pat, 'ZF1')) === 15 && Boolean(await ProductModel.exists({ shopId: pat, nameLower: 'zifi 200 tablet' })));
  const inv = await patC.raw('GET', `/transfers/${t2.id}/pdf`);
  check('the tax invoice downloads', inv.status === 200 && inv.text.startsWith('%PDF'));

  section('3. Cancel before it arrives');
  const s3 = data<Tr>(await owner.post('/transfers', { clientRequestId: randomUUID(), toShopId: slt, lines: [{ batchId: String(dl1?._id), quantity: 20 }] }));
  check('sent 20 more (120 → 100)', (await qtyOf(mainId, 'DL1')) === 100);
  check('cancel needs a reason → 422', (await owner.post(`/transfers/${s3.id}/cancel`, { reason: '' })).status === 422);
  check('the receiver can’t cancel it → 404', (await sltC.post(`/transfers/${s3.id}/cancel`, { reason: 'Not needed' })).status === 404);
  const cx = await owner.post(`/transfers/${s3.id}/cancel`, { reason: 'Rider did not come' });
  check('cancelled → the 20 come back (100 → 120)', cx.status === 200 && (await qtyOf(mainId, 'DL1')) === 120, code(cx));
  check('Salt Lake can’t receive it now → 409', (await sltC.post(`/transfers/${s3.id}/receive`)).status === 409 && (await qtyOf(slt, 'DL1')) === 30);

  section('4. Nobody outside the group');
  const other = await h.signIn('mina@trf2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id;
  check('another owner sees no shops to send to', data<List>(await other.get('/transfers')).shops.length === 0);
  check('…can’t send to Krishna’s branch → 422', (await other.post('/transfers', { clientRequestId: randomUUID(), toShopId: slt, lines: [{ batchId: String(new Types.ObjectId()), quantity: 1 }] })).status === 422);
  check('…nor read its paper → 404', (await other.raw('GET', `/transfers/${t1.id}/pdf`)).status === 404);

  section('5. GST: shops on one GSTIN together; tax invoices between shops count (v1.25.3)');
  interface Gst { scope: string; shared: { gstin: string; shops: { name: string }[] } | null; salesTaxable: number; outTax: number; inTax: number; b2b: { billNumber: string; gstin: string; taxable: number; igst: number }[]; purchases: { gstin: string; taxable: number; igst: number }[]; sales: { hsn: string; taxable: number }[] }
  const month = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
  const sltDolo = await ProductModel.findOne({ shopId: slt, nameLower: 'dolo 650 tablet' }).lean();
  await owner.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: 2, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 6000 }] });
  const sold = await sltC.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: String(sltDolo?._id), quantity: 1, unit: 'STRIP' }], payments: [{ mode: 'CASH', amount: 3000 }] });
  const gst = async (c: Client, scope?: string) => c.get(`/reports/gst?month=${month}${scope ? `&scope=${scope}` : ''}`);
  const main1 = data<Gst>(await gst(owner));
  const slt1 = data<Gst>(await gst(sltC));
  check('the owner is told Salt Lake shares the GSTIN', sold.status === 201 && main1.scope === 'shop' && main1.shared?.gstin === '19ABCDE1234F1Z5' && main1.shared.shops.map((s) => s.name).join() === 'Krishna Medical,Krishna Salt Lake', code(sold));
  const toPatna = main1.b2b.find((b) => b.billNumber === t2.number);
  check('the invoice to Patna is a B2B supply of the main shop: ₹19.50 + IGST ₹2.34', toPatna?.gstin === '10ABCDE1234F1Z7' && toPatna.taxable === 1950 && toPatna.igst === 234, JSON.stringify(main1.b2b));
  check('…and in its HSN 30049099 sales', (main1.sales.find((s) => s.hsn === '30049099')?.taxable ?? 0) > 1950);
  const both = data<Gst>(await gst(owner, 'gstin'));
  check('together: sales and output tax of both shops add up', both.scope === 'gstin' && both.salesTaxable === main1.salesTaxable + slt1.salesTaxable && both.outTax === main1.outTax + slt1.outTax && slt1.salesTaxable > 0, `${String(both.salesTaxable)} = ${String(main1.salesTaxable)} + ${String(slt1.salesTaxable)}`);
  check('…the challan to Salt Lake is not a sale anywhere', !both.b2b.some((b) => b.billNumber === t1.number));
  const patna = data<Gst>(await gst(patC));
  const fromMain = patna.purchases.find((x) => x.gstin === '19ABCDE1234F1Z5');
  check('Patna: the received invoice is input tax, IGST ₹2.34', fromMain?.taxable === 1950 && fromMain.igst === 234 && patna.inTax === 234 && patna.shared === null, JSON.stringify(patna.purchases));
  check('Patna is alone on its GSTIN → together is 403', (await gst(patC, 'gstin')).status === 403);
  await owner.post('/staff', { email: 'anil@trf1.test', name: 'Anil', roleId: roles.find((r) => r.key === 'accountant')?.id });
  const acct = await h.signIn('anil@trf1.test');
  await acct.post(`/invitations/${data<{ id: string }[]>(await acct.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Anil' });
  acct.shopId = mainId;
  const acctGst = await gst(acct);
  check('the accountant sees GST for this shop only (not told of the others), together → 403', acctGst.status === 200 && data<Gst>(acctGst).shared === null && (await gst(acct, 'gstin')).status === 403, code(acctGst));
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const xl = await owner.raw('GET', `/reports/r/gst-sales/export?from=${month}-01&to=${today}&format=xlsx&scope=gstin`);
  check('the Excel for both shops downloads', xl.status === 200 && xl.body.subarray(0, 2).toString() === 'PK', code(xl));
  check('adding up shops in a non-GST report → 422', (await owner.raw('GET', `/reports/r/stock-on-hand/export?format=xlsx&scope=gstin`)).status === 422);

  await h.close();
  finish();
}

main().catch(crash);
