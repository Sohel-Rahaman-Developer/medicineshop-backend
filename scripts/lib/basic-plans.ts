// Basic left the list prices in Nov 2026; the checks of what a smaller plan locks make their own.
const BASIC = [
  { code: 'basic-monthly', name: 'Basic Monthly', tier: 'basic', features: [], price: 29_900, durationDays: 30, maxUsers: 2, sortOrder: 1, isActive: true },
  { code: 'basic-yearly', name: 'Basic Yearly', tier: 'basic', features: [], price: 299_000, durationDays: 365, maxUsers: 2, sortOrder: 2, isActive: true },
];

/** The suites that test the paid add-on start with the 50 free-for-life places already taken. */
export async function fillFreeForLife(): Promise<void> {
  const { FreeForLifeModel } = await import('../../src/modules/webaddress/web-address.model.js');
  const { Types } = await import('mongoose');
  await FreeForLifeModel.insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: new Types.ObjectId(), rank: i + 1, at: new Date() })));
}

export async function seedBasic(): Promise<void> {
  const { PlanModel } = await import('../../src/modules/subscription/billing.model.js');
  const { ensurePlans, forgetPlanFeatures } = await import('../../src/modules/subscription/plan-access.js');
  await ensurePlans();
  for (const { isActive, ...b } of BASIC) await PlanModel.updateOne({ code: b.code }, { $set: { isActive }, $setOnInsert: b }, { upsert: true });
  forgetPlanFeatures();
}

/** Takes the test-only Basic plans off sale again, so the next suite sees the list prices. */
export async function offBasic(): Promise<void> {
  const { PlanModel } = await import('../../src/modules/subscription/billing.model.js');
  const { forgetPlanFeatures } = await import('../../src/modules/subscription/plan-access.js');
  await PlanModel.updateMany({ code: { $in: BASIC.map((b) => b.code) } }, { $set: { isActive: false } });
  forgetPlanFeatures();
}
