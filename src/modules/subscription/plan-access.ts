import { DEFAULT_PLANS, PlanModel } from './billing.model';
import { D87_FEATURES, FEATURES, allFeatures, type Feature } from './features';

// Plans change rarely: one read a minute, dropped at once when the admin saves plans.
let cache: { at: number; map: Map<string, Feature[]> } | null = null;
export const forgetPlanFeatures = () => {
  cache = null;
};

let ready = false;
/** A fresh database gets the placeholder list (PLAN §8). D87, once: plans from before tiers become Pro with every
 * module, and Basic joins off sale until the admin prices it. Runs before any plan is read. */
export async function ensurePlans() {
  if (ready) return;
  if (!(await PlanModel.exists({}))) await PlanModel.insertMany(DEFAULT_PLANS, { ordered: false }).catch(() => undefined);
  const old = await PlanModel.find({ tier: { $exists: false } }).lean();
  for (const p of old) await PlanModel.updateOne({ _id: p._id, tier: { $exists: false } }, { $set: { tier: 'pro', features: allFeatures(), ...(p.name === 'Monthly' || p.name === 'Yearly' ? { name: `Pro ${p.name}` } : {}) } });
  if (old.length) for (const b of DEFAULT_PLANS.filter((x) => x.tier === 'basic')) await PlanModel.updateOne({ code: b.code }, { $setOnInsert: { ...b, isActive: false, sortOrder: b.sortOrder - 10 } }, { upsert: true });
  // A module added later (D90 clinic) opens on every Pro plan once; Basic stays as the admin set it.
  for (const p of await PlanModel.find({}).select('tier knows').lean()) {
    const knows = p.knows?.length ? p.knows : D87_FEATURES;
    const fresh = FEATURES.filter((f) => !knows.includes(f));
    if (!fresh.length) continue;
    await PlanModel.updateOne({ _id: p._id }, { $set: { knows: [...FEATURES] }, ...(p.tier === 'pro' ? { $addToSet: { features: { $each: fresh } } } : {}) });
  }
  cache = null;
  ready = true;
}

/** Tests run the D87 check again on an old-style plan list. */
export const forgetTiers = () => {
  ready = false;
};

/** Trial and the demo shop see everything; a plan saved before D87 (no list) keeps everything it had. */
export async function featuresOf(planCode: string, now = Date.now()): Promise<Feature[]> {
  if (planCode === 'trial' || planCode === 'demo') return allFeatures();
  await ensurePlans();
  if (!cache || now - cache.at > 60_000) {
    const rows = await PlanModel.find({}).select('code features').lean();
    cache = { at: now, map: new Map(rows.map((r) => [r.code, (r.features ?? allFeatures()) as Feature[]])) };
  }
  return cache.map.get(planCode) ?? allFeatures();
}
