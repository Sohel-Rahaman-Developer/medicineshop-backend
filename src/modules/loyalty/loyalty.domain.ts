// Pure points maths (PLAN §16), ported from sandbox domain.js. Points are whole numbers; money is paise.

export interface Tier {
  name: string;
  minLifetimePoints: number;
  earnMultiplier: number;
}

export interface LoyaltyRules {
  enabled: boolean;
  configured: boolean;
  earnRate: number;
  earnPerAmount: number;
  minBillForEarning: number;
  excludedCategories: string[];
  earnOnDiscountedAmount: boolean;
  pointValue: number;
  minPointsToRedeem: number;
  maxRedeemPercent: number;
  redeemMultipleOf: number;
  pointExpiryMonths: number;
  expiryWarningDays: number;
  tiers: Tier[];
  birthdayBonusPoints: number;
  signupBonusPoints: number;
}

export const DEFAULT_RULES: LoyaltyRules = {
  enabled: false,
  configured: false,
  earnRate: 1,
  earnPerAmount: 10_000,
  minBillForEarning: 0,
  excludedCategories: [],
  earnOnDiscountedAmount: true,
  pointValue: 100,
  minPointsToRedeem: 100,
  maxRedeemPercent: 20,
  redeemMultipleOf: 10,
  pointExpiryMonths: 12,
  expiryWarningDays: 30,
  tiers: [
    { name: 'Silver', minLifetimePoints: 0, earnMultiplier: 1 },
    { name: 'Gold', minLifetimePoints: 1000, earnMultiplier: 1.25 },
    { name: 'Platinum', minLifetimePoints: 5000, earnMultiplier: 1.5 },
  ],
  birthdayBonusPoints: 100,
  signupBonusPoints: 50,
};

/** The highest tier whose threshold the lifetime points reach; tiers are sorted by threshold. */
export function tierFor(lifetime: number, tiers: readonly Tier[]): Tier | null {
  let out: Tier | null = tiers[0] ?? null;
  for (const t of tiers) if (lifetime >= t.minLifetimePoints) out = t;
  return out;
}

export const nextTier = (lifetime: number, tiers: readonly Tier[]) => tiers.find((t) => lifetime < t.minLifetimePoints) ?? null;

/** Bill ₹1,250, Gold 1.25×, 1 per ₹100 → floor(1250/100) = 12 → floor(12 × 1.25) = 15 (PLAN §16). */
export function earn(amount: number, tierName: string, r: LoyaltyRules) {
  const tier = r.tiers.find((t) => t.name === tierName) ?? r.tiers[0];
  const mult = tier?.earnMultiplier ?? 1;
  if (!r.enabled || amount <= 0 || amount < r.minBillForEarning || r.earnPerAmount <= 0) return { amount, base: 0, mult, points: 0 };
  const base = Math.floor(amount / r.earnPerAmount) * r.earnRate;
  // The multiplier has 2 decimals; integer maths so 20 × 1.15 is 23, not 22.99.
  return { amount, base, mult, points: Math.floor((base * Math.round(mult * 100)) / 100) };
}

/** Bill ₹1,250, 340 points, 20 %, ₹1 a point, multiples of 10 → ₹250 → 250 points usable (PLAN §16). */
export function redeemCap(grandTotal: number, balance: number, r: LoyaltyRules) {
  const maxValue = Math.floor((grandTotal * r.maxRedeemPercent) / 100);
  const maxPoints = r.pointValue > 0 ? Math.floor(maxValue / r.pointValue) : 0;
  let usable = Math.max(0, Math.min(maxPoints, balance));
  if (r.redeemMultipleOf > 1) usable -= usable % r.redeemMultipleOf;
  const eligible = r.enabled && balance >= r.minPointsToRedeem && usable > 0;
  return { maxValue, maxPoints, balance, usable: eligible ? usable : 0, eligible };
}

/** Points that follow a share of the bill back: cumulative, so returning everything moves exactly all of them. */
export const shareOf = (points: number, part: number, whole: number, all: boolean) => (all || whole <= 0 ? points : Math.floor((points * part) / whole));

/** Earned points keep this many months; 0 = never expire. */
export function expiryOf(at: Date, months: number): Date | null {
  if (!months) return null;
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
