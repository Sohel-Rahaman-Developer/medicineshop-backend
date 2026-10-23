import Anthropic from '@anthropic-ai/sdk';
import { Schema, model } from 'mongoose';
import { AppError } from '../../core/errors';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { AskQuestionModel } from '../ask/ask.model';
import { PROVIDER_NAME, aiSettings } from './ai-settings';
import { AI_MODELS, AI_MODEL_IDS, AI_PROVIDERS, AiReadModel, type AiProvider } from './ai.model';

// D97: neither Anthropic nor Google tells an API key its balance, so the admin writes down each top-up and the
// recorded cost of every call since then gives the estimate; under the admin's line, the super admins get an email.

const topupSchema = new Schema({ usd: { type: Number, required: true }, at: { type: Date, required: true }, by: { type: String, required: true }, note: { type: String, default: '' } }, { _id: false });
const creditSchema = new Schema(
  {
    _id: { type: String, enum: AI_PROVIDERS },
    alertUsd: { type: Number, required: true, default: 10 },
    topups: { type: [topupSchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);
export const AiCreditModel = model('AiCredit', creditSchema);

const modelsOf = (p: AiProvider) => AI_MODEL_IDS.filter((m) => AI_MODELS[m].provider === p);
const cents = (usd: number) => Math.round(usd * 100) / 100;

/** Per provider: what was put in, what the calls since the first top-up cost, what is left, and whether it is low. */
export async function credits() {
  const [s, docs] = await Promise.all([aiSettings(), AiCreditModel.find({}).lean()]);
  return Promise.all(
    AI_PROVIDERS.map(async (p) => {
      const d = docs.find((x) => x._id === p);
      const topups = d?.topups ?? [];
      const since = topups.length ? topups.reduce((a, t) => (t.at < a ? t.at : a), topups[0]?.at ?? new Date()) : null;
      let spentPaise = 0;
      if (since) {
        // Free-tier calls cost nothing, so they don't eat into the credit.
        const match = { createdAt: { $gte: since }, model: { $in: modelsOf(p) }, freeTier: { $ne: true } };
        const [r, q] = await Promise.all([
          AiReadModel.aggregate<{ cost: number }>([{ $match: match }, { $group: { _id: null, cost: { $sum: '$costPaise' } } }]),
          AskQuestionModel.aggregate<{ cost: number }>([{ $match: match }, { $group: { _id: null, cost: { $sum: '$costPaise' } } }]),
        ]);
        spentPaise = (r[0]?.cost ?? 0) + (q[0]?.cost ?? 0);
      }
      const loadedUsd = cents(topups.reduce((a, t) => a + t.usd, 0));
      const spentUsd = cents(spentPaise / 100 / s.usdInr);
      const leftUsd = cents(loadedUsd - spentUsd);
      return { provider: p, name: PROVIDER_NAME[p], alertUsd: d?.alertUsd ?? 10, loadedUsd, spentUsd, leftUsd, since, low: topups.length > 0 && leftUsd < (d?.alertUsd ?? 10), topups: [...topups].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 10) };
    }),
  );
}

export async function addTopup(a: AdminActor, p: AiProvider, input: { usd: number; at?: Date; note: string }, reason: string, ip?: string) {
  const at = input.at ?? new Date();
  if (at.getTime() > Date.now() + 86_400_000) throw AppError.validation('A top-up can’t be in the future', [{ field: 'body.at', message: 'In the future' }]);
  await AiCreditModel.updateOne({ _id: p }, { $push: { topups: { $each: [{ usd: input.usd, at, by: a.name, note: input.note }], $slice: -200 } } }, { upsert: true });
  await log(a, 'ai_credit_topup', reason, `added $${input.usd.toFixed(2)} of ${PROVIDER_NAME[p]} credit`, undefined, undefined, ip);
  return credits();
}

export async function setAlert(a: AdminActor, p: AiProvider, alertUsd: number, reason: string, ip?: string) {
  await AiCreditModel.updateOne({ _id: p }, { $set: { alertUsd } }, { upsert: true });
  await log(a, 'ai_credit_alert', reason, `${PROVIDER_NAME[p]} credit alert below $${alertUsd.toFixed(2)}`, undefined, undefined, ip);
  return credits();
}

/** Anthropic answers 400 “Your credit balance is too low” when the account is empty. */
export const outOfCredit = (err: unknown) => err instanceof Anthropic.APIError && err.status === 400 && /credit balance/i.test(err.message);

/** Providers under the admin's line (the scheduler emails the super admins, once a day each). */
export async function lowCredits() {
  return (await credits()).filter((c) => c.low);
}
