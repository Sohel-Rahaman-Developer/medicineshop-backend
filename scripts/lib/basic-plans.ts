// D113: a fresh database sells Basic Monthly / Yearly at the list prices; these helpers take them off sale and back,
// and set what the Basic package opens for a check.

/** The suites that test the paid add-on start with the 50 free-for-life places already taken. */
export async function fillFreeForLife(): Promise<void> {
  const { FreeForLifeModel } = await import('../../src/modules/webaddress/web-address.model.js');
  const { Types } = await import('mongoose');
  await FreeForLifeModel.insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: new Types.ObjectId(), rank: i + 1, at: new Date() })));
}

const CODES = ['basic-monthly', 'basic-yearly'];

export async function seedBasic(): Promise<void> {
  const { PlanModel } = await import('../../src/modules/subscription/billing.model.js');
  const { ensurePlans, forgetPlanFeatures } = await import('../../src/modules/subscription/plan-access.js');
  await ensurePlans();
  await PlanModel.updateMany({ code: { $in: CODES } }, { $set: { isActive: true } });
  forgetPlanFeatures();
}

/** Takes Basic off sale, for the checks of a Pro-only price list. */
export async function offBasic(): Promise<void> {
  const { PlanModel } = await import('../../src/modules/subscription/billing.model.js');
  const { ensurePlans, forgetPlanFeatures } = await import('../../src/modules/subscription/plan-access.js');
  await ensurePlans();
  await PlanModel.updateMany({ code: { $in: CODES } }, { $set: { isActive: false } });
  forgetPlanFeatures();
}

/** What the Basic package opens, as the admin would tick it. */
export async function basicOpens(features: string[]): Promise<void> {
  const { PackageModel } = await import('../../src/modules/subscription/billing.model.js');
  const { ensurePlans, forgetPlanFeatures } = await import('../../src/modules/subscription/plan-access.js');
  await ensurePlans();
  await PackageModel.updateOne({ _id: 'basic' }, { $set: { features } });
  forgetPlanFeatures();
}

/** The list before D113 — Pro only, ₹499 a month and ₹3,600 a year with GST inside — for the suites about payment
 * mechanics, so their worked sums stay as written. The D113 list itself is checked in smoke-plans. */
export async function oldPriceList(): Promise<void> {
  const { PlanModel } = await import('../../src/modules/subscription/billing.model.js');
  const { ensurePlans, forgetPlanFeatures } = await import('../../src/modules/subscription/plan-access.js');
  await ensurePlans();
  await PlanModel.updateOne({ code: 'monthly' }, { $set: { price: 49_900 }, $unset: { basePrice: 1 } });
  await PlanModel.updateOne({ code: 'yearly' }, { $set: { price: 360_000 }, $unset: { basePrice: 1 } });
  await PlanModel.updateMany({ code: { $in: CODES } }, { $set: { isActive: false } });
  forgetPlanFeatures();
}
