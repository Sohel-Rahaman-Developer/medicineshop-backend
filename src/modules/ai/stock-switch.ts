import { Schema, Types, model } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { tenantScoped } from '../../core/tenant-scope';
import { audit } from '../audit/audit.model';
import type { Actor } from '../user/actor';

// A lock on adding or changing stock with the AI: off unless the person turns it on, and off again by itself after
// 15 minutes without use. Each person has their own; nothing the AI fills can be saved while it is off.
const switchSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** On until this moment; every use moves it 15 minutes on. */
    until: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
switchSchema.index({ shopId: 1, userId: 1 }, { unique: true });
switchSchema.plugin(tenantScoped);
export const AiStockSwitchModel = model('AiStockSwitch', switchSchema);

export const AI_STOCK_IDLE_MS = 15 * 60 * 1000;
export const AI_STOCK_OFF = 'AI_STOCK_OFF';

const who = (t: TenantContext, actor: Actor) => ({ shopId: t.shopId, userId: new Types.ObjectId(actor.id) });

export async function switchOf(t: TenantContext, actor: Actor, now = new Date()) {
  const s = await AiStockSwitchModel.findOne(who(t, actor)).select('until').lean();
  const on = Boolean(s && s.until.getTime() > now.getTime());
  return { on, until: on && s ? s.until : null, idleMinutes: AI_STOCK_IDLE_MS / 60_000 };
}

export async function setSwitch(t: TenantContext, actor: Actor, on: boolean, ip?: string, now = new Date()) {
  const before = await switchOf(t, actor, now);
  await AiStockSwitchModel.updateOne(who(t, actor), { $set: { until: on ? new Date(now.getTime() + AI_STOCK_IDLE_MS) : now } }, { upsert: true });
  if (before.on !== on) {
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'purchases', entityId: actor.id, entityName: actor.name, text: on ? `${actor.name} turned on adding stock with AI (off by itself after 15 minutes without use)` : `${actor.name} turned off adding stock with AI`, ip });
  }
  return switchOf(t, actor, now);
}

/** Before any AI stock work: the person's switch must be on; using it keeps it on 15 more minutes. */
export async function needSwitch(t: TenantContext, actor: Actor, now = new Date()) {
  const r = await AiStockSwitchModel.updateOne({ ...who(t, actor), until: { $gt: now } }, { $set: { until: new Date(now.getTime() + AI_STOCK_IDLE_MS) } });
  if (!r.matchedCount) throw new AppError(403, 'FORBIDDEN', 'Adding stock with AI is off — turn it on first', { reason: AI_STOCK_OFF });
}
