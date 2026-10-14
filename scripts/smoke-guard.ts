// D97 checks: AI never costs MedBox24 more than coins bring in — a losing price can't be saved or run, each read's
// output is capped by its pages, a Word file pays by its length, a shop can't spend past what it paid for (failed
// reads included), and the admin sees who spends what.
import { randomUUID } from 'node:crypto';
import { startFakeClaude } from './lib/fake-claude';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';
import { makeBillPdf } from './lib/bill-pdf';
import { makeDocx } from './lib/docx';
import { MA_AI, MA_FOOT, MA_HEADER, MA_LINES, MA_TOP } from './lib/ma-bill';

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
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);
const b64 = (b: Buffer, type: string) => `data:${type};base64,${b.toString('base64')}`;
// Default packs: ₹299 / 25, ₹999 / 100, ₹4,499 / 500 → the cheapest coin is ₹4,499 ÷ 1.18 ÷ 500 = ₹7.62.
const PACKS = [{ code: 'c25', name: 'Starter', coins: 25, price: 29_900 }, { code: 'c100', name: 'Shop', coins: 100, price: 99_900 }, { code: 'c500', name: 'Busy shop', coins: 500, price: 449_900 }];

interface Money {
  targetMargin: number;
  coin: { paise: number };
  read: { safe: boolean; worstPaise: number; chargePaise: number; suggestCoins: number; avgPaise: number | null };
  chat: { safe: boolean; worstPaise: number };
  shops: { shopName: string; paidPaise: number; giftedCoins: number; costPaise: number; allowancePaise: number; leftPaise: number; reads: { done: number; failed: number }; users: { name: string; costPaise: number }[] }[];
}

async function main() {
  const fake = await startFakeClaude();
  process.env.AI_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { AiReadModel, AiSettingsModel, CoinWalletModel } = await import('../src/modules/ai/ai.model.js');
  const { SignalModel } = await import('../src/services/monitor.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const { tick } = await import('../src/modules/notifications/jobs.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@guard1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  const ma = data<{ id: string }>(await owner.post('/suppliers', { name: 'M.A. Pharma', contactPerson: '', phone: '98360 90271', email: '', gstin: '', drugLicense: '', creditDays: 15, address: 'Hridaypur' })).id;
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id ?? '';
  await owner.post('/products', { name: 'Azikem 500 Tablet', company: 'Generic', salt: 'Azithromycin', strength: '', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 5, units: { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 3, purchase: 'BOX', purchasePack: 10, allowLooseSale: true }, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, stock: { clientRequestId: randomUUID(), batchNumber: '25443288', expiry: '2028-01', quantity: 30, mrp: 7553, purchaseRate: 2819, rack: '' } });
  const other = await h.signIn('mina@guard2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id;

  await AdminUserModel.create([{ email: 'root@guard.test', name: 'Root', role: 'super' }, { email: 'view@guard.test', name: 'Vik Viewer', role: 'viewer' }]);
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const r = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' }));
    await c.post('/admin/auth/totp', { code: totpAt(r.secret ?? '', Math.floor(Date.now() / 30_000)) });
    return c;
  };
  const root = await login('root@guard.test');
  const viewer = await login('view@guard.test');
  await root.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic console' });
  const settings = (over: Record<string, unknown> = {}) => ({ settings: { enabled: true, model: 'claude-opus-5-5', effort: 'low', coinsPerPage: 3, maxPages: 10, welcomeCoins: 0, targetMargin: 1.5, usdInr: 88, packs: PACKS, ...over }, reason: 'AI reading prices' });
  const balance = async () => (await CoinWalletModel.findOne({ shopId: shop }).lean())?.balance ?? 0;
  const readAi = (c: Client, file: Buffer, type: string, name: string) => c.post('/purchases/import/ai', { supplierId: ma, fileName: name, data: b64(file, type) });
  const money = async () => data<Money>(await viewer.get('/admin/ai/money'));

  section('1. A price that could lose money can’t be saved');
  const lossy = await root.put('/admin/ai/settings', settings({ coinsPerPage: 1 }));
  check('Opus 5.5 at 1 coin a page → 422: a page (4,000 in × $5 + 8,000 out × $20) / 1M × ₹88 = ₹15.84 against ₹7.62', lossy.status === 422 && lossy.json.error?.message === 'That would lose money. A bill page can cost up to ₹15.84 but its tokens bring in ₹7.62 — charge more tokens a page or pick a cheaper model.', code(lossy));
  check('…the same price with reading off can be kept (nothing runs)', (await root.put('/admin/ai/settings', settings({ coinsPerPage: 1, enabled: false }))).status === 200);
  const ok3 = await root.put('/admin/ai/settings', settings());
  check('3 coins a page → ₹22.86 ≥ ₹15.84 → saved', ok3.status === 200, code(ok3));
  const cheap = await root.put('/admin/ai/settings', settings({ packs: [{ code: 'bulk', name: 'Bulk', coins: 500, price: 99_900 }] }));
  check('a pack that drops a coin to ₹1.69 (₹999 ÷ 1.18 ÷ 500) → 422, 3 coins = ₹5.07', cheap.status === 422 && String(cheap.json.error?.message).includes('its tokens bring in ₹5.07'), code(cheap));
  const m0 = await money();
  check('the money view shows it: coin ₹7.62, page worst ₹15.84 vs ₹22.86, safe; 1.5× suggests 4 coins (1.5 × ₹15.84 ÷ ₹7.62)', m0.coin.paise === 762 && m0.read.worstPaise === 1584 && m0.read.chargePaise === 2286 && m0.read.safe && m0.read.suggestCoins === 4 && m0.read.avgPaise === null, JSON.stringify(m0.read));

  section('2. A losing price left from before pauses reading — no coins taken');
  await root.post(`/admin/shops/${shopId}/coins`, { coins: 20, reason: 'coins to test the guard' });
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { coinsPerPage: 1 } });
  check('the shop’s offer turns off', !data<{ enabled: boolean }>(await owner.get('/ai/offer')).enabled);
  const seen0 = fake.seen.length;
  const paused = await readAi(owner, PHOTO, 'image/jpeg', 'bill.jpg');
  check('a read → 409 AI_PAUSED, “No tokens were taken”, Claude not asked, no read recorded', paused.status === 409 && reason(paused) === 'AI_PAUSED' && String(paused.json.error?.message).endsWith('No tokens were taken.') && fake.seen.length === seen0 && (await balance()) === 20 && (await AiReadModel.countDocuments({ shopId: shop })) === 0, code(paused));
  check('MedBox24 is told (a monitor signal)', Boolean(await SignalModel.exists({ kind: 'ai_paused' })));
  check('the money view marks it unsafe', !(await money()).read.safe);

  section('3. Each read can spend only what its pages pay for');
  await root.put('/admin/ai/settings', settings({ model: 'claude-sonnet-5-5', coinsPerPage: 2 }));
  fake.answer = { bill: MA_AI, input: 3200, output: 2400 };
  const r1 = await readAi(owner, PHOTO, 'image/jpeg', 'bill.jpg');
  check('a photo (1 page): Claude may answer 8,000 tokens at most (was 32,000)', r1.status === 200 && fake.seen.at(-1)?.maxTokens === 8000, `${code(r1)} ${String(fake.seen.at(-1)?.maxTokens)}`);
  const scan = await makeBillPdf(MA_TOP, MA_HEADER, MA_LINES, MA_FOOT, { perPage: 5, scan: true });
  const r3 = await readAi(owner, scan, 'application/pdf', 'scan.pdf');
  check('a 3-page scan: 24,000 at most, 6 coins', r3.status === 200 && fake.seen.at(-1)?.maxTokens === 24_000 && data<{ ai: { coins: number } }>(r3).ai.coins === 6, code(r3));
  const longDoc = makeDocx(Array.from({ length: 60 }, (_, i) => `Line ${String(i)}: ${'AZIKEM 500 TAB 10*3 GENERIC 25443288 1/28 28.19 '.repeat(7)}`), [MA_HEADER, ...MA_LINES]);
  const before = await balance();
  const rd = await readAi(owner, longDoc, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'long.docx');
  const pages = data<{ ai: { pages: number; coins: number } }>(rd).ai;
  check('a long Word file pays by its length (≈9,000 characters a page), not as one page', rd.status === 200 && pages.pages >= 3 && pages.coins === pages.pages * 2 && (await balance()) === before - pages.coins && fake.seen.at(-1)?.maxTokens === pages.pages * 8000, JSON.stringify(pages));

  section('4. A shop can’t spend past what it paid for — failed reads included');
  // A read that uses its whole allowance (4,000 in, 8,000 out — Claude stops there) and finds no lines: it fails, the coins
  // go back, ₹7.92 is spent.
  fake.answer = { bill: { ...MA_AI, lines: [] }, input: 4000, output: 40_000 };
  let pausedAt = 0;
  for (let i = 1; i <= 30 && !pausedAt; i++) {
    const r = await readAi(owner, PHOTO, 'image/jpeg', `blank-${String(i)}.jpg`);
    if (r.status === 409 && reason(r) === 'AI_PAUSED') pausedAt = i;
  }
  const row = (await money()).shops.find((x) => x.shopName === 'Shri Ram Medical Store');
  check('failed reads give the coins back, yet the spend counts: reading pauses before it would pass 20 coins × ₹7.62 = ₹152.40 — never over', pausedAt > 1 && (row?.allowancePaise ?? 0) === 15_240 && (row?.costPaise ?? Infinity) <= 15_240 && (row?.leftPaise ?? 0) < 792, JSON.stringify({ pausedAt, row }));
  check('…while the shop still holds coins (nothing was charged for the failures)', (await balance()) > 0);
  const w = await root.post(`/admin/shops/${shopId}/coins`, { coins: 30, reason: 'more coins after a check' });
  fake.answer = { bill: MA_AI, input: 3200, output: 2400 };
  check('MedBox24 gives 30 more → reading works again', w.status === 200 && (await readAi(owner, PHOTO, 'image/jpeg', 'bill.jpg')).status === 200);

  section('5. The chat pauses the same way');
  const chatOn = { chat: { enabled: true, model: 'claude-haiku-5-5', coinsPerQuestion: 1, capIn: 8000, capOut: 500, perShopDay: 30, budgetUsd: 50 }, reason: 'chat for the guard test' };
  check('chat on (Haiku 5.5: worst 11 paise vs ₹7.62)', (await root.put('/admin/ai/chat', chatOn)).status === 200);
  await other.put('/ask/ai', { on: true });
  const stopOf = async () => data<{ ai: { stop: string | null } }>(await other.get('/ask/offer')).ai.stop;
  check('a shop with no tokens → “buy tokens”', (await stopOf()) === 'noCoins');
  await root.post(`/admin/shops/${other.shopId}/coins`, { coins: 5, reason: 'tokens for the guard test' });
  check('given 5 tokens it may ask — within what it was given', (await stopOf()) === null);
  const { AskQuestionModel } = await import('../src/modules/ask/ask.model.js');
  await AskQuestionModel.create({ shopId: new Types.ObjectId(other.shopId), shopName: 'Mina Medical', userId: new Types.ObjectId(), userName: 'x', route: 'ai', voice: 'en', costPaise: 10_000 });
  check('…once its AI cost passes what it was given (₹100 > 5 × ₹7.62) → paused, though tokens are left', (await stopOf()) === 'paused');

  section('6. Who spends what');
  const m1 = await money();
  const r = m1.shops.find((x) => x.shopName === 'Shri Ram Medical Store');
  check('per shop: 50 coins given, failed and done reads, the spend, and who in the shop spent it', r?.giftedCoins === 50 && r.paidPaise === 0 && (r.reads.failed) >= 1 && r.reads.done === 4 && r.users[0]?.name === 'Rohit Agarwal' && r.users[0].costPaise === r.costPaise, JSON.stringify(r));
  check('the average real cost of a page is now known', (m1.read.avgPaise ?? 0) > 0, JSON.stringify(m1.read));
  check('a shop user can’t read it → 401', (await owner.get('/admin/ai/money')).status === 401);

  section('7. AI credit: top-ups written down, an email before it runs out');
  type Credit = { provider: string; loadedUsd: number; spentUsd: number; leftUsd: number; alertUsd: number; low: boolean };
  const claude = (r: Res) => data<Credit[]>(r).find((c) => c.provider === 'anthropic');
  check('nothing written down → not low (no estimate yet)', claude(await viewer.get('/admin/ai/credits'))?.low === false);
  check('a viewer can’t add a top-up → 403', (await viewer.post('/admin/ai/credits/anthropic', { usd: 5, reason: 'paid Anthropic today' })).status === 403);
  check('a top-up in the future → 422', (await root.post('/admin/ai/credits/anthropic', { usd: 5, at: '2099-01-01', reason: 'paid Anthropic today' })).status === 422);
  const spentPaise = (await AiReadModel.aggregate<{ c: number }>([{ $group: { _id: null, c: { $sum: '$costPaise' } } }]))[0]?.c ?? 0;
  const up = claude(await root.post('/admin/ai/credits/anthropic', { usd: 5, at: '2026-01-01', reason: 'paid Anthropic today' }));
  const spentUsd = Math.round((spentPaise / 100 / 88) * 100) / 100;
  check(`$5 put in − the recorded Claude cost (₹${(spentPaise / 100).toFixed(2)} ÷ ₹88 = $${spentUsd.toFixed(2)}) = what is left`, up?.loadedUsd === 5 && up.spentUsd === spentUsd && up.leftUsd === Math.round((5 - spentUsd) * 100) / 100, JSON.stringify(up));
  const line = claude(await root.put('/admin/ai/credits/anthropic/alert', { alertUsd: 4.99, reason: 'tell me early' }));
  check('an alert line above what is left → low', line?.low === true && line.alertUsd === 4.99, JSON.stringify(line));
  await tick(new Date());
  await tick(new Date());
  const mails = await EmailJobModel.find({ kind: 'ai_credit' }).lean();
  check('the scheduler emails the super admin once a day — “Time to top up”, Claude about $… left', mails.length === 1 && mails[0]?.to === 'root@guard.test' && mails[0].subject.includes('top up AI credit: Claude about $'), JSON.stringify(mails.map((m) => [m.to, m.subject])));
  fake.queue.push({ status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' });
  await root.post(`/admin/shops/${shopId}/coins`, { coins: 10, reason: 'coins for the credit test' });
  const empty = await readAi(owner, PHOTO, 'image/jpeg', 'bill.jpg');
  check('Anthropic says the credit is used up → the read fails, coins back, and an alert of its own', empty.status === 503 && Boolean(await SignalModel.exists({ kind: 'ai_credit_low' })), code(empty));

  await h.close();
  finish();
}

main().catch(crash);
