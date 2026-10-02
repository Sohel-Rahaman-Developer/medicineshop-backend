import { z } from 'zod';
import { clientRequestId, istDay, LIMIT, objectId, paise } from '../../core/zod';
import { LOYALTY_TYPES } from './loyalty.model';

const whole = (label: string, min: number, max: number) => z.number(`${label} must be a number`).int(`${label} must be a whole number`).min(min, `${label} is at least ${String(min)}`).max(max, `${label} is at most ${String(max)}`);

const tier = z
  .object({
    name: z.string().trim().min(1, 'Name the tier').max(20),
    minLifetimePoints: whole('From lifetime points', 0, 10_000_000),
    earnMultiplier: z.number('Earn × must be a number').min(1, 'Earn × is at least 1').max(10, 'Earn × is at most 10').multipleOf(0.01, 'Earn × has at most 2 decimals'),
  })
  .strict();

// PLAN §16 loyalty settings; money in paise, points whole.
export const rulesSchema = z
  .object({
    enabled: z.boolean(),
    earnRate: whole('Points per step', 1, 100),
    earnPerAmount: paise('Bill amount for a point').min(100, 'At least ₹1 for a point'),
    minBillForEarning: paise('Min bill'),
    excludedCategories: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    earnOnDiscountedAmount: z.boolean(),
    pointValue: paise('Point value', 100_000).min(1, 'A point is worth at least ₹0.01'),
    minPointsToRedeem: whole('Min points to redeem', 0, 1_000_000),
    maxRedeemPercent: whole('Max redeem', 1, 100),
    redeemMultipleOf: whole('Redeem in multiples of', 1, 1000),
    pointExpiryMonths: whole('Expiry months', 0, 120),
    expiryWarningDays: whole('Warn before expiry', 1, 365),
    tiers: z
      .array(tier)
      .min(1, 'Keep at least one tier')
      .max(5, 'At most 5 tiers')
      .refine((v) => v[0]?.minLifetimePoints === 0, 'The first tier starts at 0 points')
      .refine((v) => v.every((x, i) => i === 0 || x.minLifetimePoints > (v[i - 1]?.minLifetimePoints ?? 0)), 'Each tier needs more lifetime points than the one before')
      .refine((v) => new Set(v.map((x) => x.name.toLowerCase())).size === v.length, 'Two tiers have the same name'),
    birthdayBonusPoints: whole('Birthday bonus', 0, 100_000),
    signupBonusPoints: whole('Signup bonus', 0, 100_000),
  })
  .strict();

export const adjustSchema = z
  .object({
    clientRequestId,
    customerId: objectId,
    points: whole('Points', -1_000_000, 1_000_000).refine((v) => v !== 0, 'Points can’t be 0'),
    reason: z.string().trim().min(3, 'A reason is required').max(200),
  })
  .strict();

export const loyaltyListSchema = z
  .object({
    customerId: objectId.optional(),
    type: z.enum(LOYALTY_TYPES).optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export const loyaltySummarySchema = z.object({ from: istDay.optional(), to: istDay.optional() }).strict();

export type RulesInput = z.infer<typeof rulesSchema>;
export type AdjustInput = z.infer<typeof adjustSchema>;
export type LoyaltyListQuery = z.infer<typeof loyaltyListSchema>;
export type LoyaltySummaryQuery = z.infer<typeof loyaltySummarySchema>;
