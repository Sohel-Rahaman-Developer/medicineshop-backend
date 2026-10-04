// D78 checks: AI bill reading with Claude (a local stand-in for Anthropic), paid in coins — admin key and settings,
// coins by hand and by Razorpay, charge by the page, coins back on every failure, records of every read.
import { createHmac, randomUUID } from 'node:crypto';
import { startFakeClaude } from './lib/fake-claude';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';
import { makeBillPdf } from './lib/bill-pdf';
import { makeDocx } from './lib/docx';
import { MA_AI, MA_FOOT, MA_HEADER, MA_LINES, MA_TOP } from './lib/ma-bill';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error as { details?: { reason?: string } } | undefined)?.details?.reason;
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const supBody = (name: string) => ({ name, contactPerson: '', phone: '98360 90271', email: '', gstin: '', drugLicense: '', creditDays: 15, address: 'Hridaypur' });

// A JPEG as a phone saves it (the server only looks at the first bytes; Claude reads the picture).
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);
const b64 = (b: Buffer, type: string) => `data:${type};base64,${b.toString('base64')}`;

interface ReadOut { lines: { name: string; status: string; quantity: number; mrp: number; checks: string[]; productId: string | null; batchNumber: string; expiry?: string; rate: number; pack: string; discountPercent: number; gstRate?: number }[]; meta: { invoiceNumber: string | null; invoiceDate: string | null; toPay: number | null }; billCheck: string | null; skipped: string[]; ai: { readId: string; pages: number; coins: number; balance: number } }

async function main() {
  const fake = await startFakeClaude();
  process.env.AI_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { AiReadModel, AiSettingsModel, CoinEntryModel, CoinOrderModel, CoinWalletModel } = await import('../src/modules/ai/ai.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { SignalModel } = await import('../src/services/monitor.js');
  const { settleStuckReads, costPaise } = await import('../src/modules/ai/bill-ai.js');
  const { moveCoins } = await import('../src/modules/ai/coins.js');
  const { inTransaction } = await import('../src/core/transaction.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');
  const step = () => Math.floor(Date.now() / 30_000);

  const owner = await h.signIn('rohit@ai1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  const ma = data<{ id: string }>(await owner.post('/suppliers', supBody('M.A. Pharma'))).id;
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id ?? '';
  const azikem = data<{ id: string }>(await owner.post('/products', { name: 'Azikem 500 Tablet', company: 'Generic', salt: 'Azithromycin', strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 5, units: { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 3, purchase: 'BOX', purchasePack: 10, allowLooseSale: true }, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, stock: { clientRequestId: randomUUID(), batchNumber: '25443288', expiry: '2028-01', quantity: 30, mrp: 7553, purchaseRate: 2819, rack: '' } })).id;
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  await owner.post('/staff', { email: 'sunita@ai1.test', name: 'Sunita', roleId: roles.find((r) => r.key === 'cashier')?.id });
  const cashier = await h.signIn('sunita@ai1.test');
  await cashier.post(`/invitations/${data<{ id: string }[]>(await cashier.get('/invitations'))[0]?.id ?? ''}/accept`, { name: 'Sunita' });
  cashier.shopId = shopId;
  const owner2 = await h.signIn('mina@ai2.test');
  owner2.shopId = data<{ id: string }>(await owner2.post('/shops', shopBody('Mina Medical'))).id;
  const otherSupplier = data<{ id: string }>(await owner2.post('/suppliers', supBody('Other Distributor'))).id;

  await AdminUserModel.create([
    { email: 'root@medshop.test', name: 'Root', role: 'super' },
    { email: 'acc@medshop.test', name: 'Asha Accounts', role: 'accounts' },
    { email: 'view@medshop.test', name: 'Vik Viewer', role: 'viewer' },
  ]);
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const r = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' }));
    await c.post('/admin/auth/totp', { code: totpAt(r.secret ?? '', step()) });
    return c;
  };
  const root = await login('root@medshop.test');
  const acc = await login('acc@medshop.test');
  const viewer = await login('view@medshop.test');
  const balance = async () => (await CoinWalletModel.findOne({ shopId: shop }).lean())?.balance ?? 0;
  const readAi = (c: Client, file: Buffer, type: string, name: string, supplierId = ma) => c.post('/purchases/import/ai', { supplierId, fileName: name, data: b64(file, type) });
  const photo = () => readAi(owner, PHOTO, 'image/jpeg', 'bill-photo.jpg');

  section('1. Off until MedShop turns it on');
  const offer0 = data<{ enabled: boolean; balance: number }>(await owner.get('/ai/offer'));
  check('a new platform: AI reading off, 0 coins', !offer0.enabled && offer0.balance === 0, JSON.stringify(offer0));
  check('reading with AI while off → 403, nothing asked of Claude', (await photo()).status === 403 && fake.seen.length === 0);
  const settings = (over: Record<string, unknown> = {}) => ({ enabled: true, model: 'claude-sonnet-5-5', effort: 'low', coinsPerPage: 2, maxPages: 5, usdInr: 88, packs: [{ code: 'c25', name: 'Starter', coins: 25, price: 29_900 }, { code: 'c100', name: 'Shop', coins: 100, price: 99_900 }], ...over });
  const early = await root.put('/admin/ai/settings', { settings: settings(), reason: 'launch AI bill reading' });
  check('turning it on before a key is set → 422', early.status === 422, code(early));

  section('2. The Claude API key: super only, sealed, last 4 shown');
  check('accounts can’t set the key → 403', (await acc.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic' })).status === 403);
  check('not an Anthropic key → 422', (await root.put('/admin/ai/key', { apiKey: 'hello-key-123', reason: 'new key from Anthropic' })).status === 422);
  check('no reason → 422', (await root.put('/admin/ai/key', { apiKey: fake.key })).status === 422);
  const setKey = await root.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic console' });
  const shown = data<{ hasKey: boolean; keyLast4: string }>(setKey);
  check('key saved; the admin sees only its last 4', setKey.status === 200 && shown.hasKey && shown.keyLast4 === fake.key.slice(-4) && !JSON.stringify(setKey.json).includes(fake.key), code(setKey));
  const stored = await AiSettingsModel.findById('ai').lean();
  check('stored sealed — the key is not in the database as text', Boolean(stored?.keySealed) && !JSON.stringify(stored).includes(fake.key));
  check('GET /admin/ai never carries the key', !JSON.stringify((await viewer.get('/admin/ai')).json).includes(fake.key));
  const tested = data<{ ok: boolean; model: string }>(await root.post('/admin/ai/key/test', {}));
  check('“Test key” → Anthropic accepts it', tested.ok && fake.seen.length === 0, JSON.stringify(tested));
  check('setting the key is in the admin audit log with its reason', Boolean(await AdminAuditModel.exists({ action: 'ai_key_set', reason: 'new key from Anthropic console', text: { $regex: fake.key.slice(-4) } })));

  section('3. Settings: model, coins a page, packs');
  check('viewer can’t change settings → 403', (await viewer.put('/admin/ai/settings', { settings: settings(), reason: 'turn it on now' })).status === 403);
  check('two packs with one code → 422', (await root.put('/admin/ai/settings', { settings: settings({ packs: [{ code: 'a1', name: 'A', coins: 1, price: 100 }, { code: 'a1', name: 'B', coins: 2, price: 200 }] }), reason: 'turn it on now' })).status === 422);
  check('a model not on the list → 422', (await root.put('/admin/ai/settings', { settings: settings({ model: 'gpt-4' }), reason: 'turn it on now' })).status === 422);
  const on = await root.put('/admin/ai/settings', { settings: settings(), reason: 'launch AI bill reading' });
  check('on: Sonnet 5.5, 2 coins a page, 5 pages at most', on.status === 200 && data<{ enabled: boolean; model: string }>(on).model === 'claude-sonnet-5-5', code(on));
  check('the change is audited with before / after', Boolean(await AdminAuditModel.exists({ action: 'ai_settings', text: { $regex: 'turned on' } })));
  const offer1 = data<{ enabled: boolean; coinsPerPage: number; packs: unknown[] }>(await owner.get('/ai/offer'));
  check('the shop now sees it: 2 coins a page, 2 packs', offer1.enabled && offer1.coinsPerPage === 2 && offer1.packs.length === 2);
  check('cashier can’t read with AI (no purchases) → 403', (await readAi(cashier, PHOTO, 'image/jpeg', 'x.jpg')).status === 403);

  section('4. No coins → no read');
  const broke = await photo();
  check('0 coins → 409 NOT_ENOUGH_COINS, Claude not asked, no read recorded', broke.status === 409 && reason(broke) === 'NOT_ENOUGH_COINS' && fake.seen.length === 0 && (await AiReadModel.countDocuments({ shopId: shop })) === 0, code(broke));

  section('5. Coins by hand (MedShop) and by Razorpay');
  check('viewer can’t give coins → 403', (await viewer.post(`/admin/shops/${shopId}/coins`, { coins: 10, reason: 'trial coins for the demo' })).status === 403);
  check('0 coins → 422', (await acc.post(`/admin/shops/${shopId}/coins`, { coins: 0, reason: 'trial coins for the demo' })).status === 422);
  const gift = await acc.post(`/admin/shops/${shopId}/coins`, { coins: 10, reason: 'trial coins for the demo' });
  check('accounts gives 10 coins → balance 10', gift.status === 200 && (await balance()) === 10, code(gift));
  check('…in the shop’s ledger and both audit logs', Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'grant', coins: 10, balance: 10 })) && Boolean(await AdminAuditModel.exists({ action: 'coins', shopId: shop })) && Boolean(await AuditLogModel.exists({ shopId: shop, text: { $regex: 'gave 10 AI coins' } })));
  check('taking back more than the shop has → 409, balance stays 10', (await acc.post(`/admin/shops/${shopId}/coins`, { coins: -50, reason: 'given by mistake' })).status === 409 && (await balance()) === 10);
  const ord = await owner.post('/ai/coins/order', { packCode: 'c25' });
  const o = data<{ orderId: string; amount: number }>(ord);
  check('order the Starter pack: ₹299, GST ₹45.61 inside', ord.status === 201 && o.amount === 29_900 && (await CoinOrderModel.findOne({ razorpayOrderId: o.orderId }).lean())?.gst === 4_561, code(ord));
  check('unknown pack → 422', (await owner.post('/ai/coins/order', { packCode: 'gold' })).status === 422);
  check('cashier can’t buy coins → 403', (await cashier.post('/ai/coins/order', { packCode: 'c25' })).status === 403);
  const paid = await owner.post('/ai/coins/test-pay', { orderId: o.orderId });
  const paidOut = data<{ coins: number; balance: number; invoiceNumber: string; id: string }>(paid);
  check('paid → 25 coins added, balance 35, a tax invoice number', paid.status === 200 && paidOut.balance === 35 && /^MS-\d{4}-\d{2}-\d{5}$/.test(paidOut.invoiceNumber), code(paid));
  const twice = await owner.post('/ai/coins/test-pay', { orderId: o.orderId });
  check('the same payment again → replayed, still 35', data<{ replayed: boolean }>(twice).replayed && (await balance()) === 35);
  const pdfInv = await owner.raw('GET', `/ai/coins/${paidOut.id}/invoice`);
  check('the coin invoice downloads as a PDF', pdfInv.status === 200 && pdfInv.text.startsWith('%PDF'));
  const o2 = data<{ orderId: string }>(await owner.post('/ai/coins/order', { packCode: 'c100' }));
  const hook = h.client({ origin: null });
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_COIN100', order_id: o2.orderId, amount: 99_900, method: 'upi' } } } });
  const w1 = await hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sign('smoke-razorpay-webhook-secret', raw), 'x-razorpay-event-id': 'evt_coin_1' });
  check('the webhook pays a coin pack → +100, balance 135', w1.status === 200 && (await balance()) === 135, code(w1));
  await hook.raw('POST', '/webhooks/razorpay', raw, { 'x-razorpay-signature': sign('smoke-razorpay-webhook-secret', raw), 'x-razorpay-event-id': 'evt_coin_2' });
  check('the same payment in another event → no second 100', (await balance()) === 135);
  const o3 = data<{ orderId: string }>(await owner.post('/ai/coins/order', { packCode: 'c25' }));
  const rawShort = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_SHORT1', order_id: o3.orderId, amount: 100, method: 'upi' } } } });
  await hook.raw('POST', '/webhooks/razorpay', rawShort, { 'x-razorpay-signature': sign('smoke-razorpay-webhook-secret', rawShort), 'x-razorpay-event-id': 'evt_coin_3' });
  check('₹1 paid on a ₹299 pack → failed, no coins', (await CoinOrderModel.findOne({ razorpayOrderId: o3.orderId }).lean())?.status === 'failed' && (await balance()) === 135);
  const wallet = data<{ balance: number; entries: { kind: string }[]; orders: { status: string }[] }>(await owner.get('/ai/wallet'));
  check('the shop’s coin page: balance, 3 coin entries, 2 paid packs + 1 failed', wallet.balance === 135 && wallet.entries.length === 3 && wallet.orders.filter((x) => x.status === 'paid').length === 2 && wallet.orders.some((x) => x.status === 'failed'), JSON.stringify(wallet).slice(0, 300));

  section('6. Read a photo of the bill');
  fake.answer = { bill: MA_AI, input: 3200, output: 2400 };
  const r1 = await photo();
  const out1 = r1.status === 200 ? data<ReadOut>(r1) : null;
  check('photo → the 13 lines of the M.A. Pharma bill', out1?.lines.length === 13, code(r1));
  check('…invoice A085013, 1 Sep 2026, Please Pay ₹2,449, every Amount / Net and the total add up', out1?.meta.invoiceNumber === 'A085013' && out1.meta.invoiceDate === '2026-09-01' && out1.meta.toPay === 244_900 && out1.billCheck === null && out1.lines.every((l) => l.checks.length === 0), JSON.stringify([out1?.meta, out1?.billCheck]));
  const az = out1?.lines.find((l) => l.name === 'AZIKEM 500 TAB');
  check('…Azikem: the batch on the shelf (stock up), 10 strips at ₹28.19', az?.status === 'same' && az.productId === azikem && az.quantity === 10 && az.rate === 2819);
  check('…the note and TOTAL listed, not items', (out1?.skipped.some((s) => s.includes('3 PICE ER PATA DEBE')) ?? false) && (out1?.skipped.some((s) => s.includes('TOTAL')) ?? false));
  check('1 page × 2 coins → 2 coins, 133 left', out1?.ai.pages === 1 && out1.ai.coins === 2 && out1.ai.balance === 133 && (await balance()) === 133, JSON.stringify(out1?.ai));
  const seen1 = fake.seen.at(-1);
  check('Claude got the picture as an image, the chosen model and effort, a JSON schema, the saved key', seen1?.blocks[0] === 'image' && seen1.model === 'claude-sonnet-5-5' && seen1.effort === 'low' && seen1.schema && seen1.stream && seen1.key === fake.key && seen1.system.includes('Never calculate'), JSON.stringify(seen1));
  const rec1 = await AiReadModel.findById(out1?.ai.readId).lean();
  check('the read is recorded: who, supplier, file, 2 coins, 3,200 + 2,400 tokens, Anthropic’s cost ₹2.68', rec1?.status === 'done' && rec1.userName === 'Rohit Agarwal' && rec1.supplierName === 'M.A. Pharma' && rec1.fileName === 'bill-photo.jpg' && rec1.fileType === 'image' && rec1.coins === 2 && rec1.inputTokens === 3200 && rec1.outputTokens === 2400 && rec1.costPaise === 268 && rec1.lines === 13 && costPaise('claude-sonnet-5-5', 3200, 2400, 88) === 268, JSON.stringify(rec1));
  check('…and a read line in the coin ledger', Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'read', coins: -2, ref: String(rec1?._id) })));

  section('7. A 3-page scanned PDF and a Word file');
  const scan = await makeBillPdf(MA_TOP, MA_HEADER, MA_LINES, MA_FOOT, { perPage: 5, scan: true });
  const r2 = await readAi(owner, scan, 'application/pdf', 'scan.pdf');
  const out2 = r2.status === 200 ? data<ReadOut>(r2) : null;
  check('a scan (no text in it) → read by AI: 3 pages × 2 = 6 coins, 127 left', out2?.ai.pages === 3 && out2.ai.coins === 6 && (await balance()) === 127 && out2.lines.length === 13, code(r2));
  check('…sent to Claude as a PDF document', fake.seen.at(-1)?.blocks[0] === 'document');
  const docx = makeDocx(MA_TOP, [MA_HEADER, ...MA_LINES]);
  const r3 = await readAi(owner, docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'bill.docx');
  check('a Word file → 1 page, sent as its text', r3.status === 200 && data<ReadOut>(r3).ai.coins === 2 && fake.seen.at(-1)?.blocks[0] === 'text' && (await balance()) === 125, code(r3));
  const big = await makeBillPdf(MA_TOP, MA_HEADER, [...MA_LINES, ...MA_LINES], MA_FOOT, { perPage: 4 });
  const asked = fake.seen.length;
  const tooBig = await readAi(owner, big, 'application/pdf', 'big.pdf');
  check('8 pages when 5 is the limit → 422, no coins taken, Claude not asked', tooBig.status === 422 && (await balance()) === 125 && fake.seen.length === asked, code(tooBig));
  const junk = await readAi(owner, Buffer.from('just some text, not a bill'), 'text/plain', 'a.txt');
  check('not a PDF, photo or Word file → 422, no coins taken', junk.status === 422 && (await balance()) === 125);
  check('another shop’s supplier → 404, no coins taken', (await readAi(owner, PHOTO, 'image/jpeg', 'x.jpg', otherSupplier)).status === 404 && (await balance()) === 125);

  section('8. Every failure gives the coins back');
  const ledgerBefore = await CoinEntryModel.countDocuments({ shopId: shop });
  fake.queue.push({ status: 500, type: 'api_error' }, { status: 500, type: 'api_error' }, { status: 500, type: 'api_error' });
  const down = await photo();
  check('Anthropic down (after 2 retries) → 503 that says the coins are back, balance 125', down.status === 503 && /coins are back/.test(down.json.error?.message ?? '') && (await balance()) === 125, code(down));
  const failedRead = await AiReadModel.findOne({ shopId: shop, status: 'failed' }).sort({ createdAt: -1 }).lean();
  check('…the read is recorded failed and refunded; ledger: −2 then +2', failedRead?.refunded === true && (await CoinEntryModel.countDocuments({ shopId: shop })) === ledgerBefore + 2 && Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'refund', coins: 2, ref: String(failedRead._id) })));
  check('…and the admin alert counter moved', ((await SignalModel.find({ kind: 'ai_fail' }).lean()).reduce((a, s) => a + s.n, 0)) >= 1);
  fake.queue.push({ text: 'Sorry, I cannot help with that.' });
  const garbage = await photo();
  check('an answer that is not the JSON → 422, coins back', garbage.status === 422 && /coins are back/.test(garbage.json.error?.message ?? '') && (await balance()) === 125, code(garbage));
  fake.queue.push({ stop: 'refusal' });
  check('a refusal → 422, coins back', (await photo()).status === 422 && (await balance()) === 125);
  fake.queue.push({ stop: 'max_tokens' });
  check('cut off at max tokens → 422 “upload fewer pages”, coins back', /fewer pages/.test((await photo()).json.error?.message ?? '') && (await balance()) === 125);
  fake.queue.push({ bill: { ...MA_AI, lines: [], notes: ['not a bill'] } });
  check('a file with no items (not a bill) → 422, coins back', (await photo()).status === 422 && (await balance()) === 125);
  const realKey = fake.key;
  fake.key = 'sk-ant-api03-rotated-0000000000000000000000';
  const refused = await photo();
  check('Anthropic refuses the key → 503, coins back', refused.status === 503 && /key was refused/.test(refused.json.error?.message ?? '') && (await balance()) === 125, code(refused));
  check('“Test key” now says so', !data<{ ok: boolean }>(await root.post('/admin/ai/key/test', {})).ok);
  fake.key = realKey;

  section('9. Two reads at once never spend coins the shop doesn’t have');
  await inTransaction((session) => moveCoins(shop, 'grant', -(125 - 2), 'test: leave 2', 'smoke', 'smoke', session));
  const [a, b] = await Promise.all([photo(), photo()]);
  check('2 coins, two photos at once → one read, one 409', [a.status, b.status].sort().join() === '200,409' && (await balance()) === 0, `${code(a)} | ${code(b)}`);
  check('the wallet never went below 0 (ledger balances all ≥ 0)', !(await CoinEntryModel.exists({ shopId: shop, balance: { $lt: 0 } })));

  section('10. A read cut off by a restart');
  await inTransaction((session) => moveCoins(shop, 'grant', 4, 'test', 'smoke', 'smoke', session));
  const [stuck] = await AiReadModel.create([{ shopId: shop, shopName: 'Shri Ram Medical Store', userId: new Types.ObjectId(), userName: 'Rohit Agarwal', supplierId: new Types.ObjectId(ma), supplierName: 'M.A. Pharma', fileName: 'cut.jpg', fileType: 'image', pages: 2, coins: 4, model: 'claude-sonnet-5-5' }]);
  await inTransaction((session) => moveCoins(shop, 'read', -4, 'AI read cut.jpg', 'Rohit Agarwal', String(stuck?._id), session));
  await AiReadModel.collection.updateOne({ _id: stuck?._id }, { $set: { createdAt: new Date(Date.now() - 25 * 60_000) } });
  const settled = await settleStuckReads();
  const again = await settleStuckReads();
  check('25 minutes “running” → failed, 4 coins back once', settled === 1 && again === 0 && (await balance()) === 4 && (await AiReadModel.findById(stuck?._id).lean())?.refunded === true);

  section('11. Save what AI read — the usual Confirm & save');
  await inTransaction((session) => moveCoins(shop, 'grant', 10, 'test', 'smoke', 'smoke', session));
  const shelf = async () => (await BatchModel.findOne({ shopId: shop, batchNumberUpper: '25443288' }).lean())?.quantity ?? 0;
  const before = await shelf();
  const read = data<ReadOut>(await photo());
  const azr = read.lines.find((l) => l.name === 'AZIKEM 500 TAB');
  const saved = await owner.post('/purchases/import', { clientRequestId: randomUUID(), supplierId: ma, invoiceNumber: 'A085013', invoiceDate: '2026-09-01', lines: azr ? [{ productId: azr.productId, batchNumber: azr.batchNumber, expiry: azr.expiry, quantity: azr.quantity, freeQuantity: 0, unit: 'STRIP', rate: azr.rate, discountPercent: azr.discountPercent, mrp: azr.mrp, gstRate: azr.gstRate, rack: '', billName: azr.name, billPack: azr.pack }] : [] });
  check('the Azikem line from the photo saves: 30 tablets more on the shelf', saved.status === 201 && (await shelf()) - before === 30, code(saved));

  section('12. MedShop sees every read and what it cost');
  const list = await viewer.get('/admin/ai/reads?limit=50');
  const rows = data<{ shopName: string; userName: string; fileName: string; coins: number; costPaise: number; status: string; refunded: boolean; model: string }[]>(list);
  check('every read listed: shop, who, file, coins, real cost, status', list.status === 200 && rows.length === (await AiReadModel.countDocuments({})) && rows.some((r) => r.shopName === 'Shri Ram Medical Store' && r.fileName === 'bill-photo.jpg' && r.costPaise === 268 && r.model === 'claude-sonnet-5-5'), code(list));
  check('filter by shop and status', data<unknown[]>(await viewer.get(`/admin/ai/reads?shopId=${shopId}&status=failed&limit=50`)).length === (await AiReadModel.countDocuments({ shopId: shop, status: 'failed' })));
  const ov = data<{ reads: { done: number; failed: number; coins: number; costPaise: number }; sold: { orders: number; coins: number; amountPaise: number; netPaise: number }; held: { coins: number } }>(await viewer.get('/admin/ai'));
  const charged = (await AiReadModel.find({ refunded: false }).lean()).reduce((s, r) => s + r.coins, 0);
  check('overview: coins used leave out refunded reads; packs sold ₹1,298 (₹1,100 before GST); coins held', ov.reads.coins === charged && ov.sold.orders === 2 && ov.sold.amountPaise === 129_800 && ov.sold.netPaise === 129_800 - 4_561 - 15_239 && ov.held.coins === (await balance()), JSON.stringify(ov));
  check('coin orders: accounts sees them, viewer doesn’t', (await acc.get('/admin/ai/orders?limit=10')).status === 200 && (await viewer.get('/admin/ai/orders?limit=10')).status === 403);
  check('a shop’s coins on its admin page', data<{ balance: number }>(await viewer.get(`/admin/shops/${shopId}/coins`)).balance === (await balance()));

  section('13. Off again');
  await root.put('/admin/ai/settings', { settings: settings({ enabled: false }), reason: 'pause while we check costs' });
  check('turned off → the shop can’t read with AI (403), the offer says off', (await photo()).status === 403 && !data<{ enabled: boolean }>(await owner.get('/ai/offer')).enabled);
  await root.put('/admin/ai/settings', { settings: settings(), reason: 'back on after the check' });
  const removed = await root.del('/admin/ai/key', { reason: 'key leaked, rotating it' });
  check('removing the key turns AI reading off', removed.status === 200 && !data<{ enabled: boolean; hasKey: boolean }>(removed).hasKey && !data<{ enabled: boolean }>(await owner.get('/ai/offer')).enabled, code(removed));

  await h.close();
  await fake.close();
  finish();
}

main().catch(crash);
