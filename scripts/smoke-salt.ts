// D110 checks: the same salt at the counter. A medicine out of stock shows what else in stock has its salt and
// strength (the shop's own products, free); one the shop never kept is looked up by the AI after a yes, paid by what it
// used, and kept for this shop so the same name is free after.
import { randomUUID } from 'node:crypto';
import { startFakeClaude } from './lib/fake-claude';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const reason = (r: Res) => (r.json.error as { details?: { reason?: string } } | undefined)?.details?.reason;
const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const units15 = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };
type Hit = { id: string; name: string };
type Found = { route: 'confirm' | 'saved' | 'ai'; known?: boolean; salt?: string; strength?: string; options?: Hit[]; need?: number; most?: number; balance?: number; ai?: { coins: number; balance: number } };

async function main() {
  const fake = await startFakeClaude();
  process.env.AI_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { CoinEntryModel, CoinWalletModel, SaltNoteModel } = await import('../src/modules/ai/ai.model.js');
  const { AskQuestionModel } = await import('../src/modules/ask/ask.model.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@salt1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  const other = await h.signIn('mina@salt2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id;
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id;
  const mk = async (c: Client, name: string, salt: string, strength: string) => data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt, strength, categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0 })).id;
  const stock = (productId: string, batchNumber: string) => owner.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId, batchNumber, expiry: '2028-12', quantity: 30, mrp: 3000, purchaseRate: 2000 });
  const dolo = await mk(owner, 'Dolo 650 Tablet', 'Paracetamol', '650mg');
  const calpol = await mk(owner, 'Calpol 650', 'Paracetamol IP', '650 mg');
  const dolo500 = await mk(owner, 'Dolo 500', 'Paracetamol', '500mg');
  const crocin = await mk(owner, 'Crocin 650', 'Paracetamol', '650mg');
  const augmentin = await mk(owner, 'Augmentin 625 Duo', 'Amoxycillin + Clavulanic Acid', '500mg + 125mg');
  const moxikind = await mk(owner, 'Moxikind-CV 625', 'Clavulanic Acid Amoxycillin IP', '125 mg + 500 mg');
  for (const [id, b] of [[dolo, 'D1'], [calpol, 'C1'], [dolo500, 'D5'], [moxikind, 'M1']] as const) await stock(id, b);

  section('1. Out of stock at the counter → the same salt in stock, free');
  const sc = await owner.get(`/pos/same-salt/${crocin}`);
  const sameCrocin = data<{ salt: string; options: Hit[] }>(sc);
  check('Crocin 650 (none left) → Dolo 650 and Calpol 650 (“Paracetamol IP”, “650 mg” is the same); not Dolo 500, not itself', sc.status === 200 && sameCrocin.options.map((o) => o.name).sort().join() === 'Calpol 650,Dolo 650 Tablet' && sameCrocin.salt === 'Paracetamol 650mg', `${code(sc)} ${JSON.stringify(sameCrocin)}`);
  const sa = data<{ options: Hit[] }>(await owner.get(`/pos/same-salt/${augmentin}`));
  check('Augmentin 625 → Moxikind-CV 625: the same two salts and strengths in another order', sa.options.length === 1 && sa.options[0]?.id === moxikind, JSON.stringify(sa));
  check('another shop’s product → 404', (await other.get(`/pos/same-salt/${crocin}`)).status === 404);
  check('no AI was asked', fake.seen.length === 0);

  section('2. A medicine the shop never kept → the AI, after a yes');
  check('AI off → 403', (await owner.post('/pos/find-salt', { name: 'Crocin Advance' })).status === 403);
  await AdminUserModel.create({ email: 'root@salt.test', name: 'Root', role: 'super' });
  const root = h.client({ origin: 'http://localhost:3001' });
  await h.seedOtp('root@salt.test', '135790', 'admin');
  const secret = data<{ secret?: string }>(await root.post('/admin/auth/verify', { email: 'root@salt.test', otp: '135790' })).secret ?? '';
  await root.post('/admin/auth/totp', { code: totpAt(secret, Math.floor(Date.now() / 30_000)) });
  await root.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic console' });
  const on = await root.put('/admin/ai/chat', { chat: { enabled: true, model: 'claude-haiku-4-5-20251001', coinsPerQuestion: 1, capIn: 8000, capOut: 500, perShopDay: 100, budgetUsd: 50 }, reason: 'launch the shop chat' });
  check('the chat is on (its model and key look up salts too)', on.status === 200, code(on));
  const q = data<Found>(await owner.post('/pos/find-salt', { name: 'Crocin Advance' }));
  check('without a yes → “confirm” with what it may take; Claude not called, nothing set aside', q.route === 'confirm' && (q.most ?? 0) >= 1 && q.need === q.most && q.balance === 0 && fake.seen.length === 0, JSON.stringify(q));
  const none = await owner.post('/pos/find-salt', { name: 'Crocin Advance', confirm: true });
  check('yes with 0 tokens (no free AI) → 409 buy tokens, nothing asked', none.status === 409 && reason(none) === 'NOT_ENOUGH_COINS' && fake.seen.length === 0, code(none));
  await root.post(`/admin/shops/${shopId}/coins`, { coins: 20, reason: 'tokens for the salt test' });
  fake.queue.push({ say: JSON.stringify({ known: true, salt: 'Paracetamol', strength: '650mg' }), input: 180, output: 30 });
  const r1 = await owner.post('/pos/find-salt', { name: 'Crocin Advance', confirm: true });
  const a1 = data<Found>(r1);
  const sent = fake.seen[0];
  check('yes → Paracetamol 650mg, and Dolo 650 + Calpol 650 in stock to pick', r1.status === 200 && a1.route === 'ai' && a1.known === true && a1.salt === 'Paracetamol' && a1.strength === '650mg' && (a1.options ?? []).map((o) => o.name).sort().join() === 'Calpol 650,Dolo 650 Tablet', `${code(r1)} ${JSON.stringify(a1)}`);
  check('one short job: the chat’s model, a JSON answer, at most 1,024 tokens out, no tools', sent?.model === 'claude-haiku-4-5-20251001' && sent.schema && sent.maxTokens === 1024 && sent.tools.length === 0 && sent.system.includes('Never guess'), JSON.stringify(sent));
  const w1 = await CoinWalletModel.findOne({ shopId: shop }).lean();
  check('what it used was taken (1 token), the rest of the hold back; one ledger line', a1.ai?.coins === 1 && w1?.balance === 19 && w1.held === 0 && Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'ask', coins: -1, text: 'AI looked up a medicine’s salt' })), JSON.stringify(w1));
  check('…recorded as an AI question (salt), done, with its real cost', Boolean(await AskQuestionModel.exists({ shopId: shop, intent: 'salt', status: 'done', costPaise: { $gt: 0 } })));
  const seen1 = fake.seen.length;
  const again = data<Found>(await owner.post('/pos/find-salt', { name: '  crocin   ADVANCE ' }));
  check('the same name again (any case or spaces) → saved, free: no AI, no token', again.route === 'saved' && again.salt === 'Paracetamol' && (again.options ?? []).length === 2 && fake.seen.length === seen1 && (await CoinWalletModel.findOne({ shopId: shop }).lean())?.balance === 19);
  check('…another shop doesn’t get this shop’s answer (asks its own yes)', data<Found>(await other.post('/pos/find-salt', { name: 'Crocin Advance' })).route !== 'saved');

  section('3. Not sure, or not reached');
  fake.queue.push({ say: JSON.stringify({ known: false, salt: '', strength: '' }), input: 170, output: 20 });
  const u = data<Found>(await owner.post('/pos/find-salt', { name: 'Xyzzy 12', confirm: true }));
  check('the AI isn’t sure → says so, nothing to pick; its work is paid (1 token)', u.route === 'ai' && u.known === false && (u.options ?? []).length === 0 && u.ai?.coins === 1, JSON.stringify(u));
  check('…and kept, so asking again is free', data<Found>(await owner.post('/pos/find-salt', { name: 'xyzzy 12', confirm: true })).route === 'saved');
  fake.queue.push({ status: 400, type: 'invalid_request_error', message: 'bad' });
  const before = (await CoinWalletModel.findOne({ shopId: shop }).lean())?.balance;
  const down = await owner.post('/pos/find-salt', { name: 'Glycomet GP 1', confirm: true });
  check('the AI not reached → 503 “No tokens were taken”, the hold all back, nothing kept', down.status === 503 && (down.json.error?.message ?? '').includes('No tokens were taken') && (await CoinWalletModel.findOne({ shopId: shop }).lean())?.balance === before && !(await SaltNoteModel.exists({ shopId: shop, key: 'glycomet gp 1' })), code(down));
  check('two letters → 422', (await owner.post('/pos/find-salt', { name: 'ab', confirm: true })).status === 422);

  await fake.close();
  await h.close();
  finish();
}

main().catch(crash);
