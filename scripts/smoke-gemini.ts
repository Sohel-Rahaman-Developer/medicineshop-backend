// D96 checks: Gemini next to Claude — its own sealed key from the admin app, bill reading and the shop chat on a Gemini
// model (a local stand-in plays Google), coins back on every failure, removing the key turns off what used it; welcome coins.
import { randomUUID } from 'node:crypto';
import { startFakeGemini } from './lib/fake-gemini';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';
import { makeBillPdf } from './lib/bill-pdf';
import { MA_AI, MA_FOOT, MA_HEADER, MA_LINES, MA_TOP } from './lib/ma-bill';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

const shopBody = (name: string) => ({
  owner: { name: 'Rohit Agarwal', phone: '98300 41122' },
  shop: { name, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
  termsVersion: '2026-10',
  agree: true,
});
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);
const b64 = (b: Buffer, type: string) => `data:${type};base64,${b.toString('base64')}`;

interface Settings { enabled: boolean; hasKey: boolean; model: string; gemini: { hasKey: boolean; keyLast4: string | null; paid: boolean }; chat: { enabled: boolean }; models: { id: string; provider: string; free: boolean }[] }
interface ReadOut { lines: unknown[]; meta: { invoiceNumber: string | null }; ai: { readId: string; coins: number; balance: number } }

async function main() {
  process.env.RATE_ASK_PER_USER_PER_MIN = '200';
  const fake = await startFakeGemini();
  process.env.GEMINI_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { AiReadModel, AiSettingsModel, CoinWalletModel } = await import('../src/modules/ai/ai.model.js');
  const { AskQuestionModel } = await import('../src/modules/ask/ask.model.js');
  const { costPaise } = await import('../src/modules/ai/bill-ai.js');
  const { costOf } = await import('../src/modules/ask/ask-ai.js');
  const { listPrice } = await import('../src/modules/ai/ai-settings.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@gem1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  const ma = data<{ id: string }>(await owner.post('/suppliers', { name: 'M.A. Pharma', contactPerson: '', phone: '98360 90271', email: '', gstin: '', drugLicense: '', creditDays: 15, address: 'Hridaypur' })).id;
  const tablet = data<{ id: string; name: string }[]>(await owner.get('/categories')).find((c) => c.name === 'Tablet')?.id ?? '';
  const dolo = data<{ id: string }>(await owner.post('/products', { name: 'Dolo 650 Tablet', company: 'Micro Labs', salt: 'Paracetamol', strength: '650mg', categoryId: tablet, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true }, packSize: '', defaultRack: '', reorderLevel: 0, reorderQuantity: 0, stock: { clientRequestId: randomUUID(), batchNumber: 'DL1', expiry: '2028-12', quantity: 150, mrp: 3000, purchaseRate: 1950, rack: 'A1' } })).id;

  await AdminUserModel.create([{ email: 'root@gem.test', name: 'Root', role: 'super' }, { email: 'acc@gem.test', name: 'Asha Accounts', role: 'accounts' }]);
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const r = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' }));
    await c.post('/admin/auth/totp', { code: totpAt(r.secret ?? '', Math.floor(Date.now() / 30_000)) });
    return c;
  };
  const root = await login('root@gem.test');
  const acc = await login('acc@gem.test');
  const settingsOf = async () => data<{ settings: Settings }>(await root.get('/admin/ai')).settings;
  const balance = async () => (await CoinWalletModel.findOne({ shopId: shop }).lean())?.balance ?? 0;
  const readAi = (c: Client, file: Buffer, type: string, name: string) => c.post('/purchases/import/ai', { supplierId: ma, fileName: name, data: b64(file, type) });
  const read = (s: Record<string, unknown> = {}) => ({ settings: { enabled: true, model: 'gemini-3.8-flash', effort: 'medium', coinsPerPage: 2, maxPages: 5, welcomeCoins: 0, targetMargin: 1.5, usdInr: 88, packs: [{ code: 'c25', name: 'Starter', coins: 25, price: 29_900 }], ...s }, reason: 'bill reading on Gemini' });

  section('1. The Gemini key: super only, sealed, last 4 shown, Claude untouched');
  const s0 = await settingsOf();
  check('Gemini models on the list, marked Google, with a free tier where Google has one', s0.models.some((m) => m.id === 'gemini-3.8-flash' && m.provider === 'google' && m.free) && s0.models.some((m) => m.id === 'gemini-4-argon' && !m.free) && s0.models.some((m) => m.id === 'claude-haiku-5-5' && m.provider === 'anthropic'));
  check('bill reading on Gemini before its key → 422 naming Gemini', (await root.put('/admin/ai/settings', read())).status === 422 && String((await root.put('/admin/ai/settings', read())).json.error?.message).includes('Gemini'));
  check('accounts can’t set it → 403', (await acc.put('/admin/ai/gemini-key', { apiKey: fake.key, paid: false, reason: 'key from AI Studio' })).status === 403);
  check('not a Gemini key → 422', (await root.put('/admin/ai/gemini-key', { apiKey: 'sk-ant-api03-not-google-0123456789', paid: false, reason: 'key from AI Studio' })).status === 422);
  check('Google’s newer auth key (AQ.…) is taken too', (await root.put('/admin/ai/gemini-key', { apiKey: 'AQ.Ab8FakeAuthKeyForTests_0123456789-abcdef', paid: false, reason: 'auth key from AI Studio' })).status === 200); // gitleaks:allow
  const set = await root.put('/admin/ai/gemini-key', { apiKey: fake.key, paid: false, reason: 'key from AI Studio' });
  const s1 = data<Settings>(set);
  check('saved: Gemini key set, last 4 only, the Claude key still not set', set.status === 200 && s1.gemini.hasKey && s1.gemini.keyLast4 === fake.key.slice(-4) && !s1.hasKey && !JSON.stringify(set.json).includes(fake.key), code(set));
  check('stored sealed — not in the database as text', Boolean((await AiSettingsModel.findById('ai').lean())?.gemini?.keySealed) && !JSON.stringify(await AiSettingsModel.findById('ai').lean()).includes(fake.key));
  const tested = data<{ ok: boolean; model: string }>(await root.post('/admin/ai/gemini-key/test', {}));
  const probe = fake.seen.at(-1);
  check('“Test key” → Google answers; the key went in the x-goog-api-key header, never the URL', tested.ok && tested.model === 'gemini-3.8-flash' && probe?.method === 'GET' && probe.key === fake.key, JSON.stringify(tested));
  check('audited with its reason', Boolean(await AdminAuditModel.exists({ action: 'ai_key_set', reason: 'key from AI Studio', text: `set the Gemini API key (…${fake.key.slice(-4)}), free tier` })));

  section('2. Bill reading on Gemini');
  const on = await root.put('/admin/ai/settings', read());
  check('on: Gemini 3.8 Flash, medium thinking, 2 coins a page', on.status === 200 && data<Settings>(on).model === 'gemini-3.8-flash', code(on));
  check('the shop sees it on', data<{ enabled: boolean }>(await owner.get('/ai/offer')).enabled);
  await root.post(`/admin/shops/${shopId}/coins`, { coins: 30, reason: 'coins to try Gemini' });
  fake.answer = { bill: MA_AI, input: 3200, output: 2000, thoughts: 400 };
  const r1 = await readAi(owner, PHOTO, 'image/jpeg', 'bill-photo.jpg');
  const out1 = r1.status === 200 ? data<ReadOut>(r1) : null;
  check('a photo → the 13 lines of the M.A. Pharma bill, 2 coins', out1?.lines.length === 13 && out1.meta.invoiceNumber === 'A085013' && out1.ai.coins === 2 && (await balance()) === 28, code(r1));
  const g1 = fake.seen.at(-1);
  const part = g1?.body.contents?.[0]?.parts[0] as { inlineData?: { mimeType: string } } | undefined;
  const schema = g1?.body.generationConfig?.responseJsonSchema;
  check('Gemini got the picture inline, the prompt, a JSON schema (no $schema tag), thinking “medium”', g1?.model === 'gemini-3.8-flash' && part?.inlineData?.mimeType === 'image/jpeg' && (g1.body.systemInstruction?.parts[0]?.text.includes('Never calculate') ?? false) && g1.body.generationConfig?.responseMimeType === 'application/json' && Boolean(schema?.properties) && !(schema && '$schema' in schema) && g1.body.generationConfig.thinkingConfig?.thinkingLevel === 'medium', JSON.stringify(g1?.body.generationConfig));
  const rec1 = await AiReadModel.findById(out1?.ai.readId).lean();
  check('recorded on Gemini: 3,200 in, 2,000 + 400 thinking out, cost (3,200 × $0.75 + 2,400 × $3.75) / 1M × ₹88 = ₹1.00', rec1?.model === 'gemini-3.8-flash' && rec1.inputTokens === 3200 && rec1.outputTokens === 2400 && rec1.costPaise === 100 && costPaise('gemini-3.8-flash', 3200, 2400, 88) === 100, JSON.stringify(rec1));
  const scan = await makeBillPdf(MA_TOP, MA_HEADER, MA_LINES, MA_FOOT, { perPage: 5, scan: true });
  const r2 = await readAi(owner, scan, 'application/pdf', 'scan.pdf');
  const pdfPart = fake.seen.at(-1)?.body.contents?.[0]?.parts[0] as { inlineData?: { mimeType: string } } | undefined;
  check('a 3-page scan goes as a PDF → 6 coins', r2.status === 200 && pdfPart?.inlineData?.mimeType === 'application/pdf' && data<ReadOut>(r2).ai.coins === 6 && (await balance()) === 22, code(r2));

  type Bill = { month: { billedPaise: number; freeTierPaise: number; providers: { provider: string; billedPaise: number; freeTierPaise: number; bills: { calls: number } }[] } };
  const googleBill = async () => data<Bill>(await acc.get('/admin/ai/bill')).month.providers.find((x) => x.provider === 'google');
  check('the key is on the free tier → the read is marked free tier', rec1?.freeTier === true);
  const gb = await googleBill();
  check('AI bill (accounts can see it): Google ₹0 billed, the free-tier reads priced as if billed', gb?.billedPaise === 0 && (gb.freeTierPaise) >= (rec1?.costPaise ?? 1) && gb.bills.calls === 2, JSON.stringify(gb));
  await root.post('/admin/ai/credits/google', { usd: 10, reason: 'first Google top-up', note: '' });
  const gc = data<{ provider: string; spentUsd: number; leftUsd: number }[]>(await root.get('/admin/ai/credits')).find((x) => x.provider === 'google');
  check('free-tier reads don’t eat the Google credit: $10 left of $10', gc?.spentUsd === 0 && gc.leftUsd === 10, JSON.stringify(gc));

  section('3. Every failure gives the coins back');
  const failWith = async (reply: Parameters<typeof fake.queue.push>[0] | null, label: string, expect: number, text: string) => {
    if (reply) fake.queue.push(reply);
    const before = await balance();
    const r = await readAi(owner, PHOTO, 'image/jpeg', 'again.jpg');
    check(`${label} → ${String(expect)}, “${text}”, coins back`, r.status === expect && String(r.json.error?.message).includes(text) && (await balance()) === before, code(r));
  };
  await failWith({ status: 429, message: 'Resource has been exhausted' }, 'over the free tier’s limit (429)', 503, 'the AI is busy');
  await failWith({ finish: 'SAFETY' }, 'stopped for safety', 422, 'would not read this file');
  await failWith({ block: 'PROHIBITED_CONTENT' }, 'the file blocked', 422, 'would not read this file');
  await failWith({ finish: 'MAX_TOKENS' }, 'answer cut short', 422, 'too long to read in one go');
  const calls = fake.seen.length;
  fake.queue.push({ status: 503 }, { status: 503 });
  const retried = await readAi(owner, PHOTO, 'image/jpeg', 'retry.jpg');
  check('a 503 is tried again (twice) and then the bill is read', retried.status === 200 && fake.seen.length === calls + 3, code(retried));
  const realKey = fake.key;
  fake.key = 'AIzaSyAnotherKeyAfterRotation0123456789'; // gitleaks:allow
  await failWith(null, 'Google refuses the key (400 API_KEY_INVALID)', 503, 'the AI key was refused');
  check('“Test key” says Google refused it', !data<{ ok: boolean; message: string }>(await root.post('/admin/ai/gemini-key/test', {})).ok);
  fake.key = realKey;

  section('3b. The status card: why a feature is off, and one tap to fix it');
  type Status = { read: { model: string; blocks: string[] }; chat: { model: string; blocks: string[]; shopsOn: number } };
  const statusOf = async () => data<{ status: Status }>(await root.get('/admin/ai')).status;
  const flip = (b: Record<string, unknown>) => root.post('/admin/ai/switch', { reason: 'from the status card', ...b });
  check('bill reading on Gemini with its key → running, nothing to fix', (await statusOf()).read.blocks.length === 0);
  check('the chat by default (Claude Haiku 5.5, no Claude key, switched off) → “key” then “off”', (await statusOf()).chat.blocks.join() === 'key,off');
  check('accounts can’t tap it → 403', (await acc.post('/admin/ai/switch', { feature: 'read', on: false, reason: 'from the status card' })).status === 403);
  const off = await flip({ feature: 'read', on: false });
  check('“Turn off” → bill reading off, the card says “off”, the shop sees it off', off.status === 200 && data<{ status: Status }>(off).status.read.blocks.join() === 'off' && !data<{ enabled: boolean }>(await owner.get('/ai/offer')).enabled, code(off));
  const back = await flip({ feature: 'read', on: true });
  check('“Turn on” → running again; audited as turned on, with the reason', back.status === 200 && data<{ status: Status }>(back).status.read.blocks.length === 0 && Boolean(await AdminAuditModel.exists({ action: 'ai_settings', reason: 'from the status card', text: { $regex: 'turned on' } })), code(back));
  // An older setting that now loses money: ₹2,000 a dollar → a page's worst (3,750 + 30,000) × 2,000 × 100 / 1M = 6,750 paise.
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { usdInr: 2000 } });
  check('a price that now loses money → “loss” (and the feature pauses)', (await statusOf()).read.blocks.join() === 'loss' && !data<{ enabled: boolean }>(await owner.get('/ai/offer')).enabled);
  check('“Charge 6 coins” → still a loss (6 × ₹10.13 = ₹60.78 < ₹67.50) → 422', (await flip({ feature: 'read', on: true, coins: 6 })).status === 422);
  const seven = await flip({ feature: 'read', on: true, coins: 7 });
  check('“Charge 7 coins” (₹70.91) → saved, running', seven.status === 200 && data<{ status: Status; settings: Settings }>(seven).status.read.blocks.length === 0 && data<{ settings: { coinsPerPage: number } }>(seven).settings.coinsPerPage === 7, code(seven));
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { usdInr: 88, coinsPerPage: 2 } });
  check('a chat question costs 20 coins at most → 422', (await flip({ feature: 'chat', on: true, coins: 21 })).status === 422);

  section('4. The shop chat on Gemini, with the shop’s tools');
  const chatOn = { chat: { enabled: true, model: 'gemini-3.5-flash-lite', coinsPerQuestion: 1, capIn: 8000, capOut: 500, perShopDay: 100, budgetUsd: 50 }, reason: 'chat on Gemini Flash-Lite' };
  const freeTier = await root.put('/admin/ai/chat', chatOn);
  check('the chat on a free-tier Gemini key → 422 (Google may use what is sent; questions carry customers’ names)', freeTier.status === 422 && String(freeTier.json.error?.message).startsWith('Turn on billing for the Gemini key first'), code(freeTier));
  check('the chat set to Gemini but left off → saved (off needs no paid key)', (await root.put('/admin/ai/chat', { ...chatOn, chat: { ...chatOn.chat, enabled: false } })).status === 200);
  check('the card says why: “freeTier” then “off”', (await statusOf()).chat.blocks.join() === 'freeTier,off');
  check('“Turn on” as it is → 422, the free-tier reason', String((await flip({ feature: 'chat', on: true })).json.error?.message).startsWith('Turn on billing for the Gemini key first'));
  check('“Use Claude Haiku 5.5 instead” with no Claude key → 422 naming Claude', String((await flip({ feature: 'chat', on: true, model: 'claude-haiku-5-5' })).json.error?.message).includes('Claude'));
  check('“Billing is on” without the key pasted again: accounts → 403', (await acc.put('/admin/ai/gemini-key/billing', { paid: true, reason: 'billing on in AI Studio' })).status === 403);
  const billed = await root.put('/admin/ai/gemini-key/billing', { paid: true, reason: 'billing on in AI Studio' });
  check('super → billing on, the key itself untouched; audited', billed.status === 200 && data<{ settings: Settings }>(billed).settings.gemini.paid && data<{ settings: Settings }>(billed).settings.gemini.keyLast4 === fake.key.slice(-4) && Boolean(await AdminAuditModel.exists({ action: 'ai_key_billing', text: 'Gemini key: billing on' })), code(billed));
  await root.put('/admin/ai/gemini-key/billing', { paid: false, reason: 'back to the free tier' });
  check('the same key, billing on → saved and audited', (await root.put('/admin/ai/gemini-key', { apiKey: fake.key, paid: true, reason: 'billing turned on in AI Studio' })).status === 200 && Boolean(await AdminAuditModel.exists({ action: 'ai_key_set', text: { $regex: 'billing on' } })));
  check('billing on → the card says only “off”', (await statusOf()).chat.blocks.join() === 'off');
  const chatUp = await flip({ feature: 'chat', on: true });
  check('one tap → the chat runs on Gemini 3.5 Flash-Lite', chatUp.status === 200 && data<{ status: Status }>(chatUp).status.chat.blocks.length === 0 && data<{ status: Status }>(chatUp).status.chat.model === 'gemini-3.5-flash-lite', code(chatUp));
  check('chat on Gemini 3.5 Flash-Lite', (await root.put('/admin/ai/chat', chatOn)).status === 200);
  await owner.put('/ask/ai', { on: true });
  check('the card counts the shops that turned AI answers on: 1', (await statusOf()).chat.shopsOn === 1);
  fake.queue.push({ tools: [{ name: 'product_stock', args: { name: 'dolo' } }] }, { say: 'Dolo 650 mein paracetamol hai — bukhar aur dard ke liye. Stock mein hai.' });
  const n = fake.seen.length;
  const ask = await owner.post('/ask', { text: 'Dolo kis kaam aati hai', confirm: true, history: [{ role: 'user', text: 'aaj ki sale' }, { role: 'assistant', text: 'Sale — Aaj: ₹0' }] });
  const a = data<{ route: string; text: string; links?: { href: string }[] }>(ask);
  check('answered by Gemini (its thinking left out), with a link to the product', a.route === 'ai' && a.text.startsWith('Dolo 650 mein paracetamol') && !a.text.includes('thinking') && a.links?.[0]?.href === `/products/${dolo}`, JSON.stringify(a));
  const [c1, c2] = fake.seen.slice(n);
  check('round 1: Flash-Lite, 12 tools as JSON schema, max 500 out, low thinking, the earlier turns as user / model', c1?.model === 'gemini-3.5-flash-lite' && c1.body.tools?.[0]?.functionDeclarations.length === 12 && Boolean(c1.body.tools[0].functionDeclarations[0]?.parametersJsonSchema) && c1.body.generationConfig?.maxOutputTokens === 500 && c1.body.generationConfig.thinkingConfig?.thinkingLevel === 'low' && c1.body.contents?.map((x) => x.role).join(',') === 'user,model,user', JSON.stringify(c1?.body.contents?.map((x) => x.role)));
  const turns = c2?.body.contents ?? [];
  const echoed = turns.at(-2)?.parts[0] as { functionCall?: { id: string }; thoughtSignature?: string } | undefined;
  const answered = turns.at(-1)?.parts[0] as { functionResponse?: { id: string; name: string; response: { result?: string } } } | undefined;
  const fr = answered?.functionResponse;
  const result = fr?.response.result ?? '';
  check('round 2: the model’s call sent back as given (thought signature kept), then the tool’s answer with the same id', echoed?.thoughtSignature?.startsWith('sig-') === true && fr?.id === echoed.functionCall?.id && fr?.name === 'product_stock' && result.includes('Dolo 650 Tablet') && !result.includes(dolo), JSON.stringify(turns.slice(-2)).slice(0, 400));
  check('round 2: the output cap lowered to what is left (500 − 60)', c2?.body.generationConfig?.maxOutputTokens === 440, String(c2?.body.generationConfig?.maxOutputTokens));
  const q = await AskQuestionModel.findOne({ shopId: shop, route: 'ai' }).lean();
  const usage = { input: 2400, output: 120, cacheRead: 0, cacheWrite: 0 };
  check('recorded: Gemini model, 2,400 in, 120 out (thinking counted), cost (2,400 × $0.30 + 120 × $2.50) / 1M × ₹88 = 9 paise', q?.model === 'gemini-3.5-flash-lite' && q.inputTokens === 2400 && q.outputTokens === 120 && q.costPaise === costOf(usage, listPrice('gemini-3.5-flash-lite'), 88) && q.costPaise === 9, JSON.stringify(q));
  check('billing on → the question is not free tier, and the AI bill shows it billed', q?.freeTier === false && ((await googleBill())?.billedPaise ?? 0) >= (q.costPaise || 1));
  fake.queue.push({ status: 429 });
  const busy = await owner.post('/ask', { text: 'Dolo bachchon ko de sakte hain kya', confirm: true });
  const failedQ = await AskQuestionModel.findOne({ shopId: shop, status: 'failed' }).lean();
  check('Gemini busy → the question fails, the token comes back, the error says Gemini', data<{ route: string }>(busy).route === 'failed' && failedQ?.error === 'Gemini busy 429', `${code(busy)} ${JSON.stringify(busy.json.data)} ${JSON.stringify(failedQ)}`);

  section('5. Removing the Gemini key turns off what runs on it');
  const removed = await root.del('/admin/ai/gemini-key', { reason: 'key leaked, rotating' });
  const s2 = data<Settings>(removed);
  check('key gone, bill reading and the chat off (both were on Gemini)', removed.status === 200 && !s2.gemini.hasKey && !s2.enabled && !s2.chat.enabled, code(removed));
  check('the shop sees both off', !data<{ enabled: boolean }>(await owner.get('/ai/offer')).enabled && !data<{ ai: { on: boolean } }>(await owner.get('/ask/offer')).ai.on);
  check('audited: which features went off', Boolean(await AdminAuditModel.exists({ action: 'ai_key_removed', text: 'removed the Gemini API key — AI reading and the chat off' })));
  check('nothing in the API log carries the key', !JSON.stringify(await AdminAuditModel.find({}).lean()).includes(fake.key));

  section('6. Welcome coins: every shop gets them once');
  const { welcomeMissing } = await import('../src/modules/ai/welcome.js');
  const { CoinEntryModel } = await import('../src/modules/ai/ai.model.js');
  const w100 = await root.put('/admin/ai/settings', read({ enabled: false, welcomeCoins: 100 }));
  check('super sets 100 free coins a shop; audited', w100.status === 200 && Boolean(await AdminAuditModel.exists({ action: 'ai_settings', text: { $regex: 'welcomeCoins' } })), code(w100));
  const fresh = await h.signIn('nisha@gem3.test');
  fresh.shopId = data<{ id: string }>(await fresh.post('/shops', shopBody('Nisha Pharmacy'))).id;
  const wal = data<{ balance: number; entries: { kind: string; coins: number; text: string }[] }>(await fresh.get('/ai/wallet'));
  check('a new shop starts with 100 tokens, one “welcome” line in its ledger', wal.balance === 100 && wal.entries.length === 1 && wal.entries[0]?.kind === 'welcome' && wal.entries[0].coins === 100 && wal.entries[0].text === 'Welcome — 100 free AI tokens from MedBox24', JSON.stringify(wal));
  const had = await balance();
  check('the scheduler gives the older shop its 100 (made while it was 0)', (await welcomeMissing()) === 1 && (await balance()) === had + 100);
  check('…and never twice', (await welcomeMissing()) === 0 && (await balance()) === had + 100 && (await CoinEntryModel.countDocuments({ shopId: shop, kind: 'welcome' })) === 1);
  await root.put('/admin/ai/settings', read({ enabled: false, welcomeCoins: 0 }));
  const late = await h.signIn('omar@gem4.test');
  late.shopId = data<{ id: string }>(await late.post('/shops', shopBody('Omar Medicos'))).id;
  check('set to 0: a new shop gets none, the scheduler gives none', data<{ balance: number }>(await late.get('/ai/wallet')).balance === 0 && (await welcomeMissing()) === 0);

  section('Announced price rises: in force on their day, a week’s notice');
  const { aiSettings, priceOf } = await import('../src/modules/ai/ai-settings.js');
  const { upcomingPrices, noticesDue } = await import('../src/modules/ai/price-changes.js');
  const { safeNow } = await import('../src/modules/ai/guard.js');
  const { tick } = await import('../src/modules/notifications/jobs.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const ist = (s: string) => new Date(`${s}+05:30`);
  check('Argon on 1 token a page (₹10.13 a token, a page up to ₹7.92) → saved', (await root.put('/admin/ai/settings', read({ enabled: false, model: 'gemini-4-argon', coinsPerPage: 1 }))).status === 200);
  const nov20 = await aiSettings(ist('2026-11-20T10:00:00'));
  const argon = upcomingPrices(nov20, ist('2026-11-20T10:00:00')).find((c) => c.model === 'gemini-4-argon');
  check('20 Nov: Argon still $2 / $10', priceOf(nov20, 'gemini-4-argon').input === 2 && priceOf(nov20, 'gemini-4-argon').output === 10);
  check('ahead: Argon from 1 Dec IST, $2 / $10 → $4 / $20, in 11 days', argon?.from.toISOString() === '2026-11-30T18:30:00.000Z' && argon.now.input === 2 && argon.next.input === 4 && argon.next.output === 20 && argon.days === 11, JSON.stringify(argon));
  check('…bill reading on Argon: a page up to ₹15.84, 1 token brings ₹10.13 → pauses, 2 tokens needed', argon?.uses.length === 1 && argon.uses[0]?.feature === 'read' && argon.uses[0].worstPaise === 1584 && argon.uses[0].chargePaise === 1013 && !argon.uses[0].safe && argon.uses[0].needCoins === 2, JSON.stringify(argon?.uses));
  check('3.8 / 3.6 Flash from 1 Jan 2027, not in use → nothing to do', upcomingPrices(nov20, ist('2026-11-20T10:00:00')).filter((c) => c.model !== 'gemini-4-argon').every((c) => c.uses.length === 0 && c.next.input === 1.5 && c.next.output === 7.5));
  check('20 Nov: no notice yet (11 days out)', noticesDue(nov20, ist('2026-11-20T10:00:00')).length === 0);
  check('25 Nov: the notice is due (6 days out)', noticesDue(nov20, ist('2026-11-25T12:00:00')).map((c) => c.model).join() === 'gemini-4-argon');
  await tick(ist('2026-11-25T12:00:00'));
  await tick(ist('2026-11-25T12:20:00'));
  const notices = await EmailJobModel.find({ kind: 'ai_price' }).lean();
  check('the scheduler emails the super admin once, the fix in it', notices.length === 1 && notices[0]?.to === 'root@gem.test' && notices[0].text.includes('charge 2 tokens a page'), JSON.stringify(notices.map((n) => [n.to, n.subject])));
  const dec2 = await aiSettings(ist('2026-12-02T09:00:00'));
  check('2 Dec: Argon counted at $4 / $20 on its own (cache write $5) — bill reading pauses', priceOf(dec2, 'gemini-4-argon').input === 4 && priceOf(dec2, 'gemini-4-argon').output === 20 && priceOf(dec2, 'gemini-4-argon').cacheWrite === 5 && !safeNow(dec2, 'read'));
  check('prices saved before the day (today) → the rise still comes in', (await root.put('/admin/ai/prices', { prices: (await aiSettings()).prices, reason: 'prices as Google lists them' })).status === 200 && priceOf(await aiSettings(ist('2026-12-02T09:00:00')), 'gemini-4-argon').input === 4);
  await AiSettingsModel.updateOne({ _id: 'ai' }, { $set: { pricesSetAt: ist('2026-12-05T10:00:00'), prices: (await aiSettings()).prices.map((p) => (p.model === 'gemini-4-argon' ? { ...p, input: 3, output: 15, cacheWrite: 3.75 } : p)) } });
  check('prices saved after the day → the admin’s price stands ($3 / $15)', priceOf(await aiSettings(ist('2026-12-10T09:00:00')), 'gemini-4-argon').input === 3);
  const overview = data<{ priceChanges: { model: string; from: string }[] }>(await root.get('/admin/ai'));
  check('the AI page lists the rises still ahead', Array.isArray(overview.priceChanges) && overview.priceChanges.every((c) => new Date(c.from) > new Date()));

  await fake.close();
  await h.close();
  finish();
}

main().catch(crash);
