import { DEFAULT_PACKAGES, DEFAULT_PLANS, PackageModel, PlanModel, withGst } from './billing.model';
import { D87_FEATURES, FEATURES, REPORTS_SPLIT, TIERS, allFeatures, isFeature, type Feature, type Tier } from './features';
import { planAt, type PlanState } from './subscription.model';

export interface Package { tier: Tier; name: string; features: Feature[]; maxUsers: number }
// Plans change rarely: one read a minute, dropped at once when the admin saves plans.
let cache: { at: number; tiers: Map<string, Tier>; packages: Map<Tier, Package> } | null = null;
export const forgetPlanFeatures = () => {
  cache = null;
};

let ready = false;
/** A fresh database gets the list prices; older ones are brought forward once (D87, D113). Runs before any plan is read. */
export async function ensurePlans() {
  if (ready) return;
  if (!(await PlanModel.exists({}))) await PlanModel.insertMany(DEFAULT_PLANS, { ordered: false }).catch(() => undefined);
  // D87: plans from before tiers become Pro with every module.
  const old = await PlanModel.find({ tier: { $exists: false } }).lean();
  for (const p of old) await PlanModel.updateOne({ _id: p._id, tier: { $exists: false } }, { $set: { tier: 'pro', features: allFeatures(), ...(p.name === 'Monthly' || p.name === 'Yearly' ? { name: `Pro ${p.name}` } : {}) } });
  // D113: the one "reports" switch becomes the registers and each report — a plan that had it keeps every one.
  const swap = (l: string[]) => [...new Set(l.flatMap((f): readonly string[] => (f === 'reports' ? REPORTS_SPLIT : [f])))];
  for (const p of await PlanModel.find({ $or: [{ features: 'reports' }, { knows: 'reports' }] }).select('features knows').lean()) {
    await PlanModel.updateOne({ _id: p._id }, { $set: { ...(p.features ? { features: swap(p.features) } : {}), ...(p.knows ? { knows: swap(p.knows) } : {}) } });
  }
  // Before packages a newer module (D90 clinic) opened on Pro plans once; the packages are made from these lists.
  for (const p of await PlanModel.find({ features: { $exists: true } }).select('tier knows').lean()) {
    const knows = p.knows?.length ? p.knows : swap([...D87_FEATURES]);
    const fresh = FEATURES.filter((f) => !knows.includes(f));
    if (fresh.length) await PlanModel.updateOne({ _id: p._id }, { $set: { knows: [...FEATURES] }, ...(p.tier === 'pro' ? { $addToSet: { features: { $each: fresh } } } : {}) });
  }
  if (!(await PackageModel.exists({}))) await toPackages();
  // A feature added later opens on Pro once; Basic stays as the admin set it.
  for (const p of await PackageModel.find({}).lean()) {
    const fresh = FEATURES.filter((f) => !p.knows.includes(f));
    if (fresh.length) await PackageModel.updateOne({ _id: p._id }, { $set: { knows: [...FEATURES] }, ...(p._id === 'pro' ? { $addToSet: { features: { $each: fresh } } } : {}) });
  }
  cache = null;
  ready = true;
}

/** D113, once: Pro keeps what the Pro plans opened, Basic starts from the list; the four list plans take the 10 Nov prices. */
async function toPackages() {
  const plans = await PlanModel.find({}).sort({ isActive: -1, sortOrder: 1 }).lean();
  const pro = plans.filter((p) => p.tier === 'pro');
  const proFeatures = pro[0]?.features ? pro[0].features.filter(isFeature) : allFeatures();
  const proUsers = Math.max(10, ...pro.map((p) => p.maxUsers ?? 0));
  await PackageModel.insertMany([...DEFAULT_PACKAGES.filter((p) => p._id === 'basic'), { _id: 'pro', name: 'Pro', features: proFeatures, knows: [...FEATURES], maxUsers: proUsers }], { ordered: false }).catch(() => undefined);
  for (const d of DEFAULT_PLANS) await PlanModel.updateOne({ code: d.code }, { $set: d }, { upsert: true });
  // A plan the admin made keeps its price, its base rounded to the rupee.
  for (const p of plans.filter((x) => x.basePrice == null && !DEFAULT_PLANS.some((d) => d.code === x.code))) {
    const base = Math.max(100, Math.round(p.price / 118) * 100);
    await PlanModel.updateOne({ _id: p._id }, { $set: { basePrice: base, price: withGst(base) } });
  }
}

/** Tests run the migrations again on an old-style plan list. */
export const forgetTiers = () => {
  ready = false;
};

async function load(now: number) {
  await ensurePlans();
  if (!cache || now - cache.at > 60_000) {
    const [plans, packs] = await Promise.all([PlanModel.find({}).select('code tier').lean(), PackageModel.find({}).lean()]);
    const packages = new Map<Tier, Package>();
    for (const t of TIERS) {
      const p = packs.find((x) => x._id === t);
      packages.set(t, { tier: t, name: p?.name ?? (t === 'pro' ? 'Pro' : 'Basic'), features: p ? p.features.filter(isFeature) : allFeatures(), maxUsers: p?.maxUsers ?? 10 });
    }
    cache = { at: now, tiers: new Map(plans.map((r) => [r.code, r.tier])), packages };
  }
  return cache;
}

export async function packages(now = Date.now()) {
  return (await load(now)).packages;
}
export async function packageOfPlan(planCode: string, now = Date.now()) {
  const c = await load(now);
  const tier = c.tiers.get(planCode);
  return tier ? (c.packages.get(tier) ?? null) : null;
}

/** Trial and the demo see everything; a plan code the admin deleted keeps everything (a paying shop never loses work).
 * D113: the package as it is now, plus what the paid period opened when it was paid. */
export async function featuresOf(sub: PlanState, now = new Date()): Promise<Feature[]> {
  const p = planAt(sub, now);
  if (p.planCode === 'trial' || p.planCode === 'demo') return allFeatures();
  const pack = await packageOfPlan(p.planCode, now.getTime());
  if (!pack) return allFeatures();
  const kept = p.kept && now < p.kept.until ? p.kept.features : [];
  return kept.length ? FEATURES.filter((f) => pack.features.includes(f) || kept.includes(f)) : pack.features;
}
