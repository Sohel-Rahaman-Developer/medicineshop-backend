// D81 checks: "Ask your shop" — free answers in three languages from the shop's own data, AI only on yes, inside the
// admin's caps (tokens, day, month), paid by free questions then coins, every coin back when no answer is given.
import { randomUUID } from 'node:crypto';
import { startFakeClaude } from './lib/fake-claude';
import { check, crash, finish, section, startHarness, type Client, type Res } from './lib/harness';

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
const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;
const isoDay = () => new Date(Date.now() + IST).toISOString().slice(0, 10);

interface Card { title: string; rows: { label: string; value: string }[]; items: { name: string; value: string; sub?: string; href?: string }[]; note?: string; href?: string }
interface Answer { route: string; voice: string; cards?: Card[]; text?: string; canAsk?: boolean; links?: { href: string }[]; ai?: { balance: number }; suggestions?: string[] }
const row = (c: Card | undefined, label: string) => c?.rows.find((r) => r.label === label)?.value;
const inrOf = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

async function main() {
  process.env.RATE_ASK_PER_USER_PER_MIN = '200';
  const fake = await startFakeClaude();
  process.env.AI_BASE_URL = fake.url;
  const h = await startHarness();
  const { AdminUserModel, AdminAuditModel } = await import('../src/modules/admin/admin.model.js');
  const { CoinEntryModel, CoinWalletModel } = await import('../src/modules/ai/ai.model.js');
  const { AskQuestionModel } = await import('../src/modules/ask/ask.model.js');
  const { AuditLogModel } = await import('../src/modules/audit/audit.model.js');
  const { settleStuckQuestions } = await import('../src/modules/ask/ask.service.js');
  const { costOf } = await import('../src/modules/ask/ask-ai.js');
  const { listPrice } = await import('../src/modules/ai/ai-settings.js');
  const { AI_GROUP, CHIPS } = await import('../src/modules/ask/texts.js');
  const { PurchaseModel } = await import('../src/modules/purchases/purchase.model.js');
  const { BatchModel } = await import('../src/modules/stock/batch.model.js');
  const { CustomerModel } = await import('../src/modules/customers/customer.model.js');
  const { ProductModel } = await import('../src/modules/products/product.model.js');
  const { SubscriptionModel } = await import('../src/modules/subscription/subscription.model.js');
  const { SignalModel } = await import('../src/services/monitor.js');
  const { totpAt } = await import('../src/utils/totp.js');
  const { Types } = await import('mongoose');

  const owner = await h.signIn('rohit@ask1.test');
  const shopId = data<{ id: string }>(await owner.post('/shops', shopBody('Shri Ram Medical Store'))).id;
  owner.shopId = shopId;
  const shop = new Types.ObjectId(shopId);
  await SubscriptionModel.updateOne({ shopId }, { $set: { maxUsers: 10 } });
  const roles = data<{ id: string; key: string | null }[]>(await owner.get('/roles'));
  const invite = async (email: string, key: string) => {
    await owner.post('/staff', { email, name: email.split('@')[0], roleId: roles.find((r) => r.key === key)?.id });
    const c = await h.signIn(email);
    await c.post(`/invitations/${data<{ id: string }[]>(await c.get('/invitations'))[0]?.id ?? ''}/accept`, { name: email.split('@')[0] });
    c.shopId = shopId;
    return c;
  };
  const cashier = await invite('sunita@ask1.test', 'cashier');
  const manager = await invite('vikram@ask1.test', 'manager');
  const other = await h.signIn('mina@ask2.test');
  other.shopId = data<{ id: string }>(await other.post('/shops', shopBody('Mina Medical'))).id;

  const cats = data<{ id: string; name: string }[]>(await owner.get('/categories'));
  const tablet = cats.find((c) => c.name === 'Tablet')?.id;
  const mk = async (c: Client, name: string, salt: string, strength: string, reorderLevel = 0, categoryId = tablet) => data<{ id: string }>(await c.post('/products', { name, company: 'Micro Labs', salt, strength, categoryId, scheduleType: 'OTC', storageType: 'NORMAL', hsnCode: '30049099', gstRate: 12, units: units15, packSize: '', defaultRack: '', reorderLevel, reorderQuantity: 0 })).id;
  const opening = (c: Client, productId: string, batchNumber: string, quantity: number, mrp: number) => c.post('/stock/opening', { clientRequestId: randomUUID(), rack: 'A1', productId, batchNumber, expiry: '2028-12', quantity, mrp, purchaseRate: Math.round(mrp * 0.65) });
  const dolo = await mk(owner, 'Dolo 650 Tablet', 'Paracetamol', '650mg');
  const pacimol = await mk(owner, 'Pacimol 650', 'Paracetamol', '650mg');
  const shelcal = await mk(owner, 'Shelcal 500', 'Calcium', '500mg', 50);
  const zifi = await mk(owner, 'Zifi 200', 'Cefixime', '200mg');
  await opening(owner, dolo, 'DL1', 150, 3000);
  await opening(owner, pacimol, 'PC1', 20, 2800);
  await opening(owner, shelcal, 'SH1', 30, 12_000);
  await opening(owner, zifi, 'ZF1', 10, 10_000);
  await BatchModel.updateOne({ shopId: shop, batchNumber: 'SH1' }, { $set: { expiryDate: new Date(Date.now() + 10 * DAY) } });
  await BatchModel.updateOne({ shopId: shop, batchNumber: 'ZF1' }, { $set: { expiryDate: new Date(Date.now() - 5 * DAY) } });
  await mk(other, 'Mina Secret Syrup', 'Secret', '', 0, data<{ id: string; name: string }[]>(await other.get('/categories')).find((c) => c.name === 'Tablet')?.id);

  const sell = (c: Client, qty: number, mode: string) => c.post('/sales', { clientRequestId: randomUUID(), items: [{ productId: dolo, quantity: qty, unit: 'STRIP' }], payments: [{ mode, amount: qty * 3000 }] });
  const bills = [await sell(owner, 2, 'CASH'), await sell(cashier, 1, 'UPI'), await sell(owner, 1, 'CASH')];
  check('setup: 3 bills (owner ₹60 + ₹30 cash, cashier ₹30 UPI)', bills.every((r) => r.status === 201), bills.map(code).join(' | '));
  const rahim = data<{ id: string }>(await owner.post('/customers', { name: 'Rahim Sheikh', phone: '98300 55511' })).id;
  await CustomerModel.updateOne({ shopId: shop, _id: new Types.ObjectId(rahim) }, { $set: { creditBalance: 45_000 } });
  const sup = data<{ id: string }>(await owner.post('/suppliers', { name: 'Sharma Distributors', contactPerson: 'Anil', phone: '98311 22334', email: '', gstin: '', drugLicense: '', creditDays: 30, address: 'Kolkata' })).id;
  const pur = await owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: sup, invoiceNumber: 'SD/1', invoiceDate: isoDay(), lines: [{ productId: dolo, batchNumber: 'DL2', expiry: '2029-01', quantity: 10, freeQuantity: 0, unit: 'STRIP', rate: 2000, discountPercent: 0, mrp: 3000, gstRate: 12, rack: '' }] });
  check('setup: a ₹224 purchase on credit, Rahim owes ₹450', pur.status === 201, code(pur));

  const askAs = async (c: Client, text: string, over: Record<string, unknown> = {}) => {
    const r = await c.post('/ask', { text, ...over });
    return { r, a: data<Answer>(r) };
  };
  const card = (a: Answer) => a.cards?.[0];

  section('1. Free answers: every chip, in three languages, without Claude');
  const chips = [...CHIPS.en, ...CHIPS.hi, ...CHIPS.bn];
  let free = 0;
  for (const q of chips) {
    const { r, a } = await askAs(owner, q);
    if (r.status === 200 && a.route === 'free' && card(a)?.title) free += 1;
    else check(`chip “${q}” answered free`, false, `${code(r)} ${JSON.stringify(a)}`);
  }
  check(`all ${String(chips.length)} chips answered by the software`, free === chips.length);
  check('…and Claude was not asked once', fake.seen.length === 0);
  check('each free answer is recorded with its card — never its words', (await AskQuestionModel.countDocuments({ shopId: shop, route: 'free' })) === chips.length && !JSON.stringify(await AskQuestionModel.find({ shopId: shop }).lean()).includes('বিক্রি'));

  const today = card((await askAs(owner, 'Today’s sale')).a);
  check('“Today’s sale”: net ₹120, 3 bills, average ₹40', today?.title === 'Sales — Today' && row(today, 'Net sale') === '₹120' && row(today, 'Bills') === '3' && row(today, 'Average bill') === '₹40' && today.href === '/sales', JSON.stringify(today));
  const hi = card((await askAs(owner, 'आज की बिक्री')).a);
  check('Hindi: “बिक्री — आज”, labels in Hindi, same ₹120', hi?.title === 'बिक्री — आज' && row(hi, 'बिल') === '3' && row(hi, 'कुल बिक्री (वापसी घटाकर)') === '₹120', JSON.stringify(hi));
  const bn = card((await askAs(owner, 'আজকের বিক্রি')).a);
  check('Bengali: “বিক্রি — আজ”, labels in Bengali', bn?.title === 'বিক্রি — আজ' && row(bn, 'বিল') === '3', JSON.stringify(bn));
  const hinglish = await askAs(owner, 'aaj ki sale kitni hui');
  check('Hinglish in Roman letters → a Roman Hindi answer', hinglish.a.voice === 'hi_latn' && card(hinglish.a)?.title === 'Sale — Aaj', JSON.stringify(hinglish.a));
  const banglish = await askAs(owner, 'ajker bikri koto');
  check('Banglish → a Roman Bengali answer', banglish.a.voice === 'bn_latn' && card(banglish.a)?.title === 'Bikri — Aaj', JSON.stringify(banglish.a));

  const p = await ProductModel.findOne({ shopId: shop, _id: new Types.ObjectId(dolo) }).lean();
  const left = p?.stock.sellable ?? 0;
  const strips = `${String(Math.floor(left / 15))} strip${left % 15 ? ` + ${String(left % 15)} tablet` : ''}`;
  const stock = card((await askAs(owner, 'Dolo ka stock')).a);
  check(`“Dolo ka stock” → ${strips}, batches with rack, link to the product`, stock?.title === 'Stock — Dolo 650 Tablet' && row(stock, 'Stock mein') === strips && stock.items.some((i) => i.name === 'Batch DL1' && i.sub?.includes('Rack A1') === true) && stock.href === `/products/${dolo}`, JSON.stringify(stock));
  check('a bare name (“Dolo 650”) is a stock question too', card((await askAs(owner, 'Dolo 650')).a)?.title === 'Stock — Dolo 650 Tablet');
  const salt = card((await askAs(owner, 'same salt as Dolo')).a);
  check('same salt → Pacimol 650 (Paracetamol 650mg, in stock)', salt?.items.length === 1 && salt.items[0]?.name === 'Pacimol 650' && salt.items[0].href === `/products/${pacimol}`, JSON.stringify(salt));
  const low = card((await askAs(owner, 'Running low on stock')).a);
  check('running low → Shelcal 500 (30 tablets, reorder at 50)', low?.items.some((i) => i.name === 'Shelcal 500') === true && low.href === '/reorder', JSON.stringify(low));
  const soon = card((await askAs(owner, 'Expiring in 30 days')).a);
  check('expiring in 30 days → the Shelcal batch only', soon?.items.length === 1 && soon.items[0]?.name === 'Shelcal 500' && row(soon, 'Batches') === '1', JSON.stringify(soon));
  const gone = card((await askAs(owner, 'expired medicines')).a);
  check('expired → the Zifi batch', gone?.items.length === 1 && gone.items[0]?.name === 'Zifi 200', JSON.stringify(gone));
  const due = card((await askAs(owner, 'Rahim ka udhaar kitna hai')).a);
  check('“Rahim ka udhaar” → ₹450, link to Rahim', due?.title === 'Udhaar — Rahim Sheikh' && row(due, 'Total') === '₹450' && due.href === `/customers/${rahim}`, JSON.stringify(due));
  const pay = card((await askAs(owner, 'Supplier ko kitna dena hai')).a);
  check('suppliers → ₹224 to Sharma Distributors', pay?.items[0]?.name === 'Sharma Distributors' && pay.items[0].value === '₹224', JSON.stringify(pay));
  const cash = card((await askAs(owner, 'Cash in the drawer today')).a);
  check('cash today → ₹90 in (two cash bills)', row(cash, 'Cash in') === '₹90', JSON.stringify(cash));
  const help = card((await askAs(owner, 'help')).a);
  check(`help lists the ${String(CHIPS.en.length)} ready questions`, help?.items.length === CHIPS.en.length && CHIPS.en.length === 20);

  section('1b. The questions a shop really asks: money in, buying, spending, prices, slow stock, people');
  const modes = card((await askAs(owner, 'UPI and card today')).a);
  check('“UPI and card today” → cash ₹90, UPI ₹30, ₹120 in', row(modes, 'Cash') === '₹90' && row(modes, 'UPI') === '₹30' && row(modes, 'Money in') === '₹120' && modes?.href === '/sales', JSON.stringify(modes));
  const bought = card((await askAs(owner, 'Purchases this month')).a);
  check('“Purchases this month” → ₹224 in 1 bill, all still to pay', row(bought, 'Bought for') === '₹224' && row(bought, 'Bills') === '1' && row(bought, 'Still to pay') === '₹224' && bought?.href === '/purchases', JSON.stringify(bought));
  await owner.post('/expenses', { clientRequestId: randomUUID(), date: isoDay(), category: 'Rent', description: 'October rent', amount: 800_000, paymentMode: 'UPI', fromDrawer: false, vendor: '', referenceNumber: '' });
  await owner.post('/expenses', { clientRequestId: randomUUID(), date: isoDay(), category: 'Tea & snacks', description: '', amount: 4_000, paymentMode: 'CASH', fromDrawer: true, vendor: '', referenceNumber: '' });
  const spent = card((await askAs(owner, 'is mahine ka kharcha kitna hai')).a);
  check('“is mahine ka kharcha” → ₹8,040 in 2 entries, rent first (Roman Hindi)', spent?.title === 'Kharcha — Is mahine' && row(spent, 'Total') === '₹8,040' && row(spent, 'Entries') === '2' && spent.items[0]?.name === 'Rent', JSON.stringify(spent));
  const price = card((await askAs(owner, 'MRP of Dolo')).a);
  check('“MRP of Dolo” → ₹30 per strip, GST 12%, by batch', price?.title === 'Price — Dolo 650 Tablet' && row(price, 'MRP per strip') === '₹30' && row(price, 'GST') === '12%' && price.items.some((i) => i.name === 'Batch DL1'), JSON.stringify(price));
  check('“Dolo ka daam” is the same card in Roman Hindi', card((await askAs(owner, 'Dolo ka daam')).a)?.title === 'Daam — Dolo 650 Tablet');
  const dead = card((await askAs(owner, 'Not selling for 60 days')).a);
  check('“Not selling for 60 days” → the three never sold, not Dolo', dead?.title === 'Not sold in 60 days' && row(dead, 'Products') === '3' && !dead.items.some((i) => i.name.startsWith('Dolo')) && dead.items.every((i) => i.sub === 'Never sold'), JSON.stringify(dead));
  const deadBn = card((await askAs(owner, '90 দিন ধরে বিক্রি হয়নি')).a);
  check('Bengali, 90 days → “90 দিন ধরে বিক্রি হয়নি”', deadBn?.title === '90 দিন ধরে বিক্রি হয়নি', JSON.stringify(deadBn));
  const staff = card((await askAs(owner, 'Which staff sold the most this month')).a);
  check('“Which staff sold the most” → owner ₹90 (2 bills), then the cashier ₹30', staff?.items.length === 2 && staff.items[0]?.value === '₹90' && staff.items[0].sub === 'Bills: 2' && staff.items[1]?.value === '₹30', JSON.stringify(staff));
  const staffCashier = await askAs(cashier, 'Which staff sold the most this month');
  check('…a cashier may not see who sold what', card(staffCashier.a)?.note === 'Your role cannot see this.', JSON.stringify(staffCashier.a));
  const gst = card((await askAs(owner, 'GST this month')).a);
  check('“GST this month” → GST on sales, GST on purchases, and a credit (bought more than sold)', gst?.title.startsWith('GST — ') === true && row(gst, 'GST paid on purchases') === '₹24' && row(gst, 'GST credit left') !== undefined && gst.href === '/gst', JSON.stringify(gst));
  const orders = card((await askAs(owner, 'Pending customer orders')).a);
  check('“Pending customer orders” → none waiting', row(orders, 'Waiting') === '0' && orders?.href === '/orders', JSON.stringify(orders));
  const best = card((await askAs(owner, 'Top customers this month')).a);
  check('“Top customers this month” → none yet (walk-in bills only)', best?.title === 'Top customers — This month' && best.note === 'Nothing here right now.', JSON.stringify(best));
  const ret = card((await askAs(owner, 'aaj kitna return hua')).a);
  check('“aaj kitna return hua” → today’s sales card', ret?.title === 'Sale — Aaj', JSON.stringify(ret));
  const where = card((await askAs(owner, 'Dolo kahan rakha hai')).a);
  check('“Dolo kahan rakha hai” → the stock card with its rack', where?.title === 'Stock — Dolo 650 Tablet' && where.items.some((i) => i.sub?.includes('Rack A1') === true), JSON.stringify(where));

  section('2. Each answer follows the asker’s permissions and shop');
  const own = card((await askAs(cashier, 'Today’s sale')).a);
  check('cashier sees only own bills: ₹30, 1 bill', row(own, 'Net sale') === '₹30' && row(own, 'Bills') === '1', JSON.stringify(own));
  const noProfit = card((await askAs(cashier, 'This month’s profit')).a);
  check('cashier asking profit → “Your role cannot see this”', noProfit?.note === 'Your role cannot see this.' && noProfit.rows.length === 0, JSON.stringify(noProfit));
  check('cashier asking supplier dues → no figures', card((await askAs(cashier, 'How much to pay suppliers')).a)?.note === 'Your role cannot see this.');
  const theirs = card((await askAs(other, 'Dolo ka stock')).a);
  check('another shop asking about Dolo → not found there', theirs?.note === 'Aapki dukaan mein “dolo” naam ka kuch nahi mila.', JSON.stringify(theirs));
  const mine = card((await askAs(owner, 'Mina Secret stock')).a);
  check('…and this shop can’t find the other shop’s product', mine?.note?.includes('Nothing named') === true, JSON.stringify(mine));

  section('3. No ready answer: straight to the AI when it can run — never charged when it can’t');
  const off = await askAs(owner, 'Dolo kis kaam aati hai');
  check('AI off on a new platform → says so (the buttons still work), Claude not called', off.a.route === 'blocked' && off.a.text === 'Abhi AI jawab band hain. Taiyar jawab (button wale) chalte hain.' && fake.seen.length === 0, JSON.stringify(off.a));
  const aiOffer = data<{ aiGroup: Record<string, { title: string; qs: string[] }> }>(await owner.get('/ask/offer')).aiGroup;
  check('v1.27: the chat offers 5 AI questions in each language, apart from the free ones', ['en', 'hi', 'bn'].every((l) => aiOffer[l]?.qs.length === 5) && aiOffer.en?.title === 'AI advice' && !aiOffer.en.qs.some((q) => CHIPS.en.includes(q)), JSON.stringify(aiOffer));
  const aiChips = [...AI_GROUP.en.qs, ...AI_GROUP.hi.qs, ...AI_GROUP.bn.qs];
  const notFree = (await Promise.all(aiChips.map(async (q) => [q, (await askAs(owner, q)).a.route] as const))).filter(([, r]) => r === 'free');
  check(`…none of the ${String(aiChips.length)} is caught by a ready answer (they need the AI)`, notFree.length === 0 && fake.seen.length === 0, JSON.stringify(notFree));
  check('…an older app’s “yes” changes nothing', (await askAs(owner, 'Dolo kis kaam aati hai', { confirm: true })).a.route === 'blocked' && fake.seen.length === 0);

  section('4. Admin: key, chat settings, prices');
  await AdminUserModel.create([{ email: 'root@medshop.test', name: 'Root', role: 'super' }, { email: 'view@medshop.test', name: 'Vik Viewer', role: 'viewer' }]);
  const login = async (email: string) => {
    const c = h.client({ origin: 'http://localhost:3001' });
    await h.seedOtp(email, '135790', 'admin');
    const r = data<{ secret?: string }>(await c.post('/admin/auth/verify', { email, otp: '135790' }));
    await c.post('/admin/auth/totp', { code: totpAt(r.secret ?? '', Math.floor(Date.now() / 30_000)) });
    return c;
  };
  const root = await login('root@medshop.test');
  const viewer = await login('view@medshop.test');
  const chatOn = (over: Record<string, unknown> = {}) => ({ chat: { enabled: true, model: 'claude-haiku-4-5-20251001', coinsPerQuestion: 1, capIn: 8000, capOut: 500, perShopDay: 100, budgetUsd: 50, ...over }, reason: 'launch the shop chat' });
  check('turning the chat on before a key → 422', (await root.put('/admin/ai/chat', chatOn())).status === 422);
  const fresh = data<{ settings: { model: string }; pricing: { worstPaise: number } }>(await viewer.get('/admin/ai/chat'));
  check('out of the box: Haiku 5.5, worst case (8,000 × $0.125 cache-write + 500 × $0.50) / 1M × ₹88 = 11 paise', fresh.settings.model === 'claude-haiku-5-5' && fresh.pricing.worstPaise === 11, JSON.stringify(fresh.pricing));
  await root.put('/admin/ai/key', { apiKey: fake.key, reason: 'new key from Anthropic console' });
  check('viewer can’t change the chat → 403', (await viewer.put('/admin/ai/chat', chatOn())).status === 403);
  check('an input cap under 6,000 tokens → 422', (await root.put('/admin/ai/chat', chatOn({ capIn: 2000 }))).status === 422);
  const on = await root.put('/admin/ai/chat', chatOn());
  check('super turns it on: Haiku 4.5, 1 token a question, caps 8,000 / 500', on.status === 200 && data<{ settings: { enabled: boolean } }>(on).settings.enabled, code(on));
  check('…audited with its reason', Boolean(await AdminAuditModel.exists({ action: 'ai_chat_settings', reason: 'launch the shop chat', text: { $regex: 'turned on' } })));
  const view = data<{ pricing: { worstPaise: number; coinPaise: number; chargePaise: number; safe: boolean } }>(await viewer.get('/admin/ai/chat'));
  check('worst case of a question: (8,000 × $1.25 cache-write + 500 × $5) / 1M × ₹88 = 110 paise', view.pricing.worstPaise === 110, JSON.stringify(view.pricing));
  check('a coin brings in at least ₹7.62 (₹4,499 pack ÷ 1.18 GST ÷ 500) → safe, even in the worst case', view.pricing.coinPaise === 762 && view.pricing.chargePaise === 762 && view.pricing.safe, JSON.stringify(view.pricing));
  const pricey = await root.put('/admin/ai/prices', { prices: [{ model: 'claude-haiku-4-5-20251001', input: 50, output: 5, cacheRead: 5, cacheWrite: 62.5 }], reason: 'Anthropic raised Haiku prices' });
  check('D97: a price under which a question could lose money is refused — (8,000 × $62.50 + 500 × $5) / 1M × ₹88 = ₹44.22 against ₹7.62', pricey.status === 422 && String(pricey.json.error?.message) === 'That would lose money. A chat question can cost up to ₹44.22 but its tokens bring in ₹7.62 — charge more tokens a question, lower the caps or pick a cheaper model.', code(pricey));
  check('…nothing saved, nothing audited', data<{ pricing: { worstPaise: number } }>(await viewer.get('/admin/ai/chat')).pricing.worstPaise === 110 && !(await AdminAuditModel.exists({ action: 'ai_prices', reason: 'Anthropic raised Haiku prices' })));
  const raised = await root.put('/admin/ai/prices', { prices: [{ model: 'claude-haiku-4-5-20251001', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }], reason: 'Anthropic raised Haiku prices' });
  check('a raise that still pays → saved: worst (8,000 × $2.50 + 500 × $10) / 1M × ₹88 = ₹2.20, audited', raised.status === 200 && data<{ pricing: { worstPaise: number; safe: boolean } }>(raised).pricing.worstPaise === 220 && Boolean(await AdminAuditModel.exists({ action: 'ai_prices', reason: 'Anthropic raised Haiku prices' })), code(raised));
  await root.put('/admin/ai/prices', { prices: [], reason: 'back to the list price' });

  section('5. Each shop turns AI on for itself; who and when is kept');
  const shopOff = await askAs(owner, 'Dolo kis kaam aati hai');
  check('platform on, this shop not yet → told how to turn it on, Claude not called, nothing spent', shopOff.a.route === 'blocked' && shopOff.a.text === 'Aapki dukaan mein AI jawab band hain — owner Settings → AI tokens mein chalu kar sakte hain. Taiyar jawab (button wale) chalte hain.' && fake.seen.length === 0 && !(await CoinEntryModel.exists({ shopId: shop, kind: 'ask' })), JSON.stringify(shopOff.a));
  const offOffer = data<{ ai: { on: boolean; shopOn: boolean; canSwitch: boolean; stop: string | null } }>(await owner.get('/ask/offer')).ai;
  check('the owner’s offer: platform on, shop off, can switch', offOffer.on && !offOffer.shopOn && offOffer.canSwitch && offOffer.stop === 'shopOff', JSON.stringify(offOffer));
  check('a cashier can’t see the switch nor flip it → 403', !data<{ ai: { canSwitch: boolean } }>(await cashier.get('/ask/offer')).ai.canSwitch && (await cashier.put('/ask/ai', { on: true })).status === 403);
  check('…nor a manager → 403', (await manager.put('/ask/ai', { on: true })).status === 403);
  const turned = await owner.put('/ask/ai', { on: true });
  const tOn = data<{ ai: { shopOn: boolean; stop: string | null } }>(turned).ai;
  check('the owner turns it on → on; only the empty token balance stops it now', turned.status === 200 && tOn.shopOn && tOn.stop === 'noCoins', code(turned));
  await owner.put('/ask/ai', { on: true });
  const trail = await AuditLogModel.find({ shopId: shop, entityName: 'AI answers' }).lean();
  check('…in the shop’s activity log once, with who and when (a repeat adds nothing)', trail.length === 1 && trail[0]?.text.endsWith('turned AI answers on') === true && trail[0].createdAt instanceof Date && trail[0].userName.length > 0, JSON.stringify(trail));
  check('another shop’s switch stays off', !data<{ ai: { shopOn: boolean } }>(await other.get('/ask/offer')).ai.shopOn);

  section('6. The AI answers with the shop’s tools — a token a question, no “ask?” first');
  const empty = await askAs(owner, 'Dolo kis kaam aati hai');
  check('no tokens → “AI token khatam — buy more”, Claude not called', empty.a.route === 'blocked' && empty.a.text === 'AI token khatam — Settings → AI tokens mein aur kharidiye. Taiyar jawab (button wale) chalte hain.' && fake.seen.length === 0, JSON.stringify(empty.a));
  await root.post(`/admin/shops/${shopId}/coins`, { coins: 5, reason: 'trial tokens for the chat' });
  check('a cashier → only owner / manager / accountant, Claude not called', (await askAs(cashier, 'Dolo kis kaam aati hai')).a.text === 'AI jawab owner, manager ya accountant ke liye hain — unse poochhiye.' && fake.seen.length === 0);
  fake.queue.push({ tools: [{ name: 'product_stock', input: { name: 'dolo' } }] }, { say: 'Dolo 650 mein paracetamol hai — bukhar aur dard ke liye. Stock mein hai. Dose ke liye doctor se poochhiye.' });
  const ai = await askAs(owner, 'Dolo kis kaam aati hai', { history: [{ role: 'user', text: 'aaj ki sale' }, { role: 'assistant', text: 'Sale — Aaj: ₹120' }] });
  check('answered by AI at once, a link to the product it looked up, 1 token (5 → 4)', ai.a.route === 'ai' && ai.a.text?.startsWith('Dolo 650 mein paracetamol') === true && ai.a.links?.[0]?.href === `/products/${dolo}` && ai.a.ai?.balance === 4, JSON.stringify(ai.a));
  const [first, second] = fake.seen;
  check('Claude got Haiku 4.5, the 26 read-only tools, a cached system prompt, max 500 out, no effort (Haiku 4.5 has none)', first?.model === 'claude-haiku-4-5-20251001' && first.tools.length === 26 && first.cached && first.maxTokens === 500 && !first.stream && first.effort === null, JSON.stringify({ m: first?.model, t: first?.tools.length, c: first?.cached, x: first?.maxTokens, e: first?.effort }));
  check('v1.27: the AI calls its tools together and starts “why / vs” from compare', first?.system.includes('Call every tool you need together in one turn') === true && first.system.includes('start with compare'));
  const lastUser = JSON.stringify(first?.messages.at(-1));
  check('the AI may talk about growing the shop, not only its figures', first?.system.includes('running and growing a pharmacy in India') === true && first.system.includes("look up the shop's own figures"));
  check('…the earlier turns, and “reply in Roman Hindi” with the question', first?.messages.length === 3 && lastUser.includes('Reply in Hindi written in Roman letters'), JSON.stringify(first?.messages));
  const toolResult = JSON.stringify(second?.messages.at(-1));
  check('the tool result is this shop’s Dolo, money as ₹, no ids, nothing of the other shop', toolResult.includes('Dolo 650 Tablet') && toolResult.includes('tool_result') && !toolResult.includes('"id"') && !toolResult.includes(dolo) && !toolResult.includes('Mina'), toolResult.slice(0, 300));
  const rec = await AskQuestionModel.findOne({ shopId: shop, route: 'ai' }).lean();
  const usage = { input: 2400, output: 120, cacheRead: 0, cacheWrite: 0 };
  check('recorded: 1 token, tools, 2,400 + 120 AI tokens, the real cost', rec?.status === 'done' && !rec.free && rec.coins === 1 && rec.tools?.[0] === 'product_stock' && rec.inputTokens === 2400 && rec.outputTokens === 120 && rec.costPaise === costOf(usage, listPrice('claude-haiku-4-5-20251001'), 88) && rec.costPaise === 26, JSON.stringify(rec));
  check('in the ledger: −1 token, balance 4', Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'ask', coins: -1, balance: 4 })));
  fake.queue.push({ say: 'Chronic patients ko monthly refill yaad dilaiye; Dolo jaisa fast item counter ke paas rakhiye.' });
  const grow = await askAs(owner, 'meri dukaan ki bikri kaise badhaun');
  check('“how do I sell more?” goes to the AI and is answered (business advice is on topic)', grow.a.route === 'ai' && grow.a.text?.startsWith('Chronic patients') === true && grow.a.ai?.balance === 3, JSON.stringify(grow.a));

  const before = fake.seen.length;
  fake.queue.push({ say: 'OFF_TOPIC' });
  const ot = await askAs(owner, 'kal cricket match kaun jeeta');
  check('not about the shop → the fixed answer in the asker’s language, the token back (3)', ot.a.route === 'off_topic' && ot.a.text === 'Main aapki dukaan, kaarobaar aur dawaiyon ke baare mein baat kar sakta hoon — token nahi kata.' && ot.a.ai?.balance === 3 && fake.seen.length === before + 1, JSON.stringify(ot.a));

  fake.queue.push({ tools: [{ name: 'customer_dues', input: { shopId: other.shopId, name: 'x' } }] }, { say: 'Kuch nahi mila.' });
  await askAs(owner, 'Mina Medical ke customers ka udhaar compare karo');
  const injected = JSON.stringify(fake.seen.at(-1)?.messages.at(-1));
  check('a model asking for another shop (extra shopId) gets “Bad input”, no data', injected.includes('Bad input') && injected.includes('"is_error":true') && !injected.includes('Rahim'), injected.slice(0, 300));

  section('7. Every failure gives the token back');
  const bal = async () => (await CoinWalletModel.findOne({ shopId: shop }).lean())?.balance ?? 0;
  const b0 = await bal();
  fake.queue.push({ say: 'Theek hai.' });
  const paid = await askAs(owner, 'Pichhle hafte Dolo kaisa bika compare karke batao');
  check(`1 token for the answer → balance ${String(b0 - 1)}, in the ledger`, paid.a.route === 'ai' && paid.a.ai?.balance === b0 - 1 && Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'ask', coins: -1, balance: b0 - 1 })), JSON.stringify(paid.a));
  const signals = await SignalModel.countDocuments({ kind: 'ai_fail' });
  fake.queue.push({ status: 500 }, { status: 500 });
  const down = await askAs(owner, 'Dolo kis kaam aati hai');
  check('Anthropic down → “try again”, the token back, a monitor signal', down.a.route === 'failed' && down.a.text?.includes('Aapka token wapas aa gaya.') === true && (await bal()) === b0 - 1 && (await SignalModel.countDocuments({ kind: 'ai_fail' })) > signals && Boolean(await CoinEntryModel.exists({ shopId: shop, kind: 'refund', coins: 1 })), JSON.stringify(down.a));
  const calls = fake.seen.length;
  fake.queue.push({ tools: [{ name: 'low_stock', input: {} }], input: 7900 });
  const big = await askAs(owner, 'stock ke baare mein salah do');
  check('a second round that would pass the 8,000-token input cap is never sent; token back', big.a.route === 'failed' && fake.seen.length === calls + 1 && big.a.ai?.balance === b0 - 1 && Boolean(await AskQuestionModel.exists({ shopId: shop, error: 'Over the cap', refunded: true })), JSON.stringify(big.a));

  section('8. Day limit, month budget, a restart mid-question');
  const asked = await AskQuestionModel.countDocuments({ shopId: shop, route: { $in: ['ai', 'off_topic'] } });
  await root.put('/admin/ai/chat', chatOn({ perShopDay: asked }));
  const capped = await askAs(owner, 'Dolo kis kaam aati hai');
  check(`day limit (${String(asked)}) reached → told, Claude not called`, capped.a.route === 'blocked' && capped.a.text?.includes(`aaj ke ${String(asked)} AI jawab`) === true, JSON.stringify(capped.a));
  check('…and the chat’s header knows it before anyone asks', data<{ ai: { stop: string | null } }>(await owner.get('/ask/offer')).ai.stop === 'dayLimit');
  await AskQuestionModel.create({ shopId: shop, shopName: 'Shri Ram Medical Store', userId: new Types.ObjectId(), userName: 'x', route: 'ai', voice: 'en', costPaise: 9000, createdAt: new Date() });
  await root.put('/admin/ai/chat', chatOn({ budgetUsd: 1 }));
  const broke2 = await askAs(manager, 'Dolo kis kaam aati hai');
  check('this month’s spend ≥ $1 budget (₹88) → AI rests, a monitor signal for MedBox24', broke2.a.route === 'blocked' && broke2.a.text === 'Is mahine AI aaram kar raha hai. Taiyar jawab (button wale) chalte hain.' && Boolean(await SignalModel.exists({ kind: 'ask_budget' })), JSON.stringify(broke2.a));
  await root.put('/admin/ai/chat', chatOn({ budgetUsd: 50 }));
  const stuck = await AskQuestionModel.create({ shopId: shop, shopName: 'Shri Ram Medical Store', userId: new Types.ObjectId(), userName: 'x', route: 'ai', voice: 'en', status: 'running', coins: 1 });
  // Timestamps never take a past createdAt from create(); the collection does.
  await AskQuestionModel.collection.updateOne({ _id: stuck._id }, { $set: { createdAt: new Date(Date.now() - 20 * 60_000) } });
  const b1 = await bal();
  const settled = await settleStuckQuestions();
  check('a question cut off by a restart gives its token back once', settled === 1 && (await bal()) === b1 + 1 && (await settleStuckQuestions()) === 0 && Boolean(await AskQuestionModel.exists({ _id: stuck._id, refunded: true })));

  section('9. What the owner and the admin see');
  const w = data<{ ask: { on: boolean; by: string | null; at: string | null }; questions: { userName: string; free: boolean; coins: number; refunded: boolean; offTopic: boolean; at: string }[] }>(await owner.get('/ai/wallet'));
  const sentQs = await AskQuestionModel.countDocuments({ shopId: shop, route: { $in: ['ai', 'off_topic'] } });
  check('the owner’s AI tokens page: the switch with who turned it on and when', w.ask.on && w.ask.by !== null && w.ask.at !== null, JSON.stringify(w.ask));
  check(`…every AI question (${String(sentQs)}) with who asked and when — tokens, given back`, w.questions.length === sentQs && w.questions.every((q) => q.userName && q.at && !q.free) && w.questions.some((q) => q.coins === 1 && !q.refunded) && w.questions.some((q) => q.offTopic), JSON.stringify(w.questions.slice(0, 3)));
  check('…never what was asked', !JSON.stringify(w).includes('kaam aati') && !JSON.stringify(w).includes('cricket'));
  check('a cashier can’t open it → 403', (await cashier.get('/ai/wallet')).status === 403);
  const month = data<{ shopsOn: number; month: { questions: number; free: number; unmatched: number; ai: number; offTopic: number; blocked: number; costPaise: number; coins: number }; voices: { voice: string }[]; shops: { shopName: string; aiOn: boolean }[] }>(await viewer.get('/admin/ai/chat'));
  check('admin: 1 shop has AI answers on, and the shop row says so', month.shopsOn === 1 && month.shops.find((x) => x.shopName === 'Shri Ram Medical Store')?.aiOn === true, JSON.stringify({ on: month.shopsOn, shops: month.shops }));
  const earned = (await AskQuestionModel.find({ shopId: shop, route: 'ai', status: 'done', refunded: { $ne: true } }).lean()).reduce((a, q) => a + q.coins, 0);
  check(`this month: ready answers, AI, off-topic and blocked counted; ${String(earned)} tokens earned`, month.month.free >= chips.length && month.month.unmatched === 0 && month.month.offTopic === 1 && month.month.blocked >= 5 && month.month.coins === earned && earned === 4, JSON.stringify(month.month));
  check('…by language and by shop', month.voices.some((v) => v.voice === 'bn') && month.shops.some((s) => s.shopName === 'Shri Ram Medical Store'));
  const list = await viewer.get('/admin/ai/chat/questions?limit=50');
  check('the question list never carries what was asked', list.status === 200 && !JSON.stringify(list.json).includes('kaam aati') && !JSON.stringify(list.json).includes('cricket'), code(list));

  section('9b. v1.27: the figures behind “why” and “what to do” — worked out by the server, copied by the AI');
  await root.put('/admin/ai/chat', chatOn());
  await root.post(`/admin/shops/${shopId}/coins`, { coins: 10, reason: 'tokens for the new look-ups' });
  const gupta = data<{ id: string }>(await owner.post('/suppliers', { name: 'Gupta Pharma', contactPerson: 'Ravi', phone: '98311 99887', email: '', gstin: '', drugLicense: '', creditDays: 15, address: 'Howrah' })).id;
  const pur2 = await owner.post('/purchases', { clientRequestId: randomUUID(), supplierId: gupta, invoiceNumber: 'GP/7', invoiceDate: isoDay(), lines: [{ productId: dolo, batchNumber: 'DL3', expiry: '2029-02', quantity: 10, freeQuantity: 0, unit: 'STRIP', rate: 1800, discountPercent: 0, mrp: 3000, gstRate: 12, rack: '' }] });
  check('setup: Dolo also bought from Gupta Pharma at ₹18 a strip (Sharma: ₹20)', pur2.status === 201, code(pur2));
  fake.queue.push({ tools: [{ name: 'compare', input: { period: 'month' } }, { name: 'item_margins', input: { period: 'month', order: 'low' } }, { name: 'buy_prices', input: { name: 'dolo' } }, { name: 'buy_prices', input: {} }, { name: 'busy_hours', input: { period: 'today' } }, { name: 'branch_sales', input: { period: 'month' } }, { name: 'price', input: { name: 'dolo' } }] }, { say: 'Is mahine ₹120 ki bikri; Gupta Pharma se Dolo sasta hai.' });
  const why = await askAs(owner, 'is mahine vs pichhla mahina, kya badla aur kya karun');
  check('one question, seven look-ups in one round, answered', why.a.route === 'ai' && fake.seen.at(-1)?.messages.length === 3, JSON.stringify(why.a));
  const results = (fake.seen.at(-1)?.messages.at(-1)?.content ?? []) as { content: string; is_error?: boolean }[];
  const out = (i: number) => results[i]?.content ?? '';
  const cmp = JSON.parse(out(0)) as { now: { netSales: string; bills: number }; before: { netSales: string }; changePercent: { sales: number | null } };
  check('compare: this month so far ₹120 in 3 bills, the same days of last month ₹0 → no % (nothing to compare with)', cmp.now.netSales === '₹120' && cmp.now.bills === 3 && cmp.before.netSales === '₹0' && cmp.changePercent.sales === null, out(0));
  const sold = await (await import('../src/modules/sales/sale.model.js')).SaleModel.find({ shopId: shop, status: { $ne: 'cancelled' } }).lean();
  const rev = sold.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.taxableAmount, 0), 0);
  const cost = Math.round(sold.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.costPerBaseUnit * l.quantityInBase, 0), 0));
  const margin = Math.round(((rev - cost) * 1000) / rev) / 10;
  const mg = JSON.parse(out(1)) as { items: { name: string; revenue: string; cost: string; marginPercent: number }[] };
  check(`item margins: Dolo — ${inrOf(rev)} before tax − ${inrOf(cost)} cost = ${String(margin)}%`, mg.items.length === 1 && mg.items[0]?.name === 'Dolo 650 Tablet' && mg.items[0].revenue === inrOf(rev) && mg.items[0].cost === inrOf(cost) && mg.items[0].marginPercent === margin, out(1));
  const lines = (await PurchaseModel.find({ shopId: shop, status: 'active' }).lean()).flatMap((x) => x.lines.map((l) => ({ supplier: x.supplierName, per: l.costPerBaseUnit, base: l.quantityInBase + l.freeInBase })));
  const g = lines.find((l) => l.supplier === 'Gupta Pharma');
  const sh = lines.find((l) => l.supplier === 'Sharma Distributors');
  const save = g && sh ? Math.round((sh.per - g.per) * sh.base) : -1;
  const bp = JSON.parse(out(2)) as { found: { name: string; suppliers: { supplier: string; packCost: string }[]; couldSave: string } };
  check(`buy prices of Dolo: Gupta ${inrOf(Math.round((g?.per ?? 0) * 15))} a strip first, then Sharma ${inrOf(Math.round((sh?.per ?? 0) * 15))}; Sharma’s 150 tablets at Gupta’s price save ${inrOf(save)}`, bp.found.name === 'Dolo 650 Tablet' && bp.found.suppliers.map((x) => x.supplier).join() === 'Gupta Pharma,Sharma Distributors' && bp.found.suppliers[0]?.packCost === inrOf(Math.round((g?.per ?? 0) * 15)) && bp.found.couldSave === inrOf(save) && save > 0, out(2));
  const all = JSON.parse(out(3)) as { items: { name: string; couldSave: string }[] };
  check('…without a name: the products where suppliers differ — Dolo, the same saving', all.items.length === 1 && all.items[0]?.name === 'Dolo 650 Tablet' && all.items[0].couldSave === inrOf(save), out(3));
  const busy = JSON.parse(out(4)) as { byHour: { bills: number }[]; byDay: { day: string; bills: number }[] };
  check('busy hours today: the 3 bills by hour and by weekday', busy.byHour.reduce((n, x) => n + x.bills, 0) === 3 && busy.byDay.length === 1 && busy.byDay[0]?.bills === 3 && busy.byDay[0].day === new Date(Date.now() + IST).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), out(4));
  const br = JSON.parse(out(5)) as { shops: { name: string; here: boolean; netSales: string }[] };
  check('branches for the owner: one shop (no branch yet), ₹120 this month', br.shops.length === 1 && br.shops[0]?.name === 'Shri Ram Medical Store' && br.shops[0].here && br.shops[0].netSales === '₹120', out(5));
  check('MRP goes to the AI in rupees (₹30), never as paise', out(6).includes('"mrp":"₹30"') && !out(6).includes('3000'), out(6));
  check('no other shop’s name in any of it', !results.some((x) => x.content.includes('Mina')));
  fake.queue.push({ tools: [{ name: 'branch_sales', input: { period: 'month' } }, { name: 'buy_prices', input: {} }] }, { say: 'Theek hai.' });
  await askAs(manager, 'branch ke hisaab se is mahine compare karo');
  const mr = (fake.seen.at(-1)?.messages.at(-1)?.content ?? []) as { content: string; is_error?: boolean }[];
  check('a manager: branches are the owner’s only; supplier prices yes (manager sees cost)', mr[0]?.is_error === true && mr[0].content.includes('cannot see') && mr[1]?.is_error !== true && mr[1]?.content.includes('Gupta Pharma') === true, JSON.stringify(mr).slice(0, 300));
  fake.queue.push({ tools: [{ name: 'low_stock', input: {} }], input: 200, cacheRead: 3800 }, { say: 'Shelcal mangaiye.' });
  const warm = await askAs(owner, 'stock ke baare mein salah do');
  check('a cached prompt counts at its price: 200 + 3,800 read at a tenth → (200 × $1 + 3,800 × $0.10) / $1.25 = 464 of the 8,000 cap, so the second round goes (counted in full it was 4,000 + 4,000+ → over)', warm.a.route === 'ai' && warm.a.text === 'Shelcal mangaiye.', JSON.stringify(warm.a));
  await root.put('/admin/ai/chat', chatOn({ model: 'claude-haiku-5-5' }));
  fake.queue.push({ say: 'Theek hai.' });
  await askAs(owner, 'meri dukaan ka margin kaise sudhrega');
  check('Haiku 5.5 is asked for low effort — short answers, the output cap goes to the answer', fake.seen.at(-1)?.model === 'claude-haiku-5-5' && fake.seen.at(-1)?.effort === 'low', JSON.stringify({ m: fake.seen.at(-1)?.model, e: fake.seen.at(-1)?.effort }));
  await root.put('/admin/ai/chat', chatOn());

  section('10. The owner turns AI off again');
  await owner.put('/ask/ai', { on: false });
  const seenOff = fake.seen.length;
  const offAgain = await askAs(manager, 'Dolo kis kaam aati hai');
  check('off → no AI question goes out, Claude not called', offAgain.a.route === 'blocked' && offAgain.a.text?.startsWith('Aapki dukaan mein AI jawab band hain') === true && fake.seen.length === seenOff, JSON.stringify(offAgain.a));
  check('…free answers still work', (await askAs(manager, 'Today’s sale')).a.route === 'free');
  check('…the log now has on, then off', (await AuditLogModel.find({ shopId: shop, entityName: 'AI answers' }).sort({ createdAt: 1 }).lean()).map((a) => a.text.split(' ').at(-1)).join() === 'on,off');

  section('11. Twenty-odd questions a minute per person, not more');
  let limited = false;
  for (let i = 0; i < 220 && !limited; i++) limited = (await manager.post('/ask', { text: 'help' })).status === 429;
  check('the per-person limit answers 429', limited);

  await fake.close();
  finish();
}

main().catch(crash);
