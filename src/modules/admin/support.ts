import { Schema, Types, model } from 'mongoose';
import { AppError } from '../../core/errors';
import { contextFor } from '../../core/middleware/tenant';
import type { TenantContext } from '../../core/middleware/tenant';
import { tenantScoped } from '../../core/tenant-scope';
import { audit } from '../audit/audit.model';
import { emit } from '../notifications/notifications.service';
import { reportByKey, type Params } from '../reports/catalog';
import { ShopModel } from '../shops/shop.model';
import type { Actor } from '../user/actor';
import { AdminAuditModel } from './admin.model';
import type { AdminActor } from './admin-auth';

// SANDBOX A16 / D15: the platform sees a shop's own data only with the owner's yes — for a set time, read-only, every look logged.
const supportSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    adminUserId: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    agentName: { type: String, required: true },
    reason: { type: String, required: true },
    hours: { type: Number, required: true },
    level: { type: String, enum: ['view'], required: true, default: 'view' },
    status: { type: String, enum: ['pending', 'approved', 'denied', 'revoked', 'ended'], required: true, default: 'pending' },
    decidedBy: { type: String },
    decidedAt: { type: Date },
    startedAt: { type: Date },
    endsAt: { type: Date },
    endedAt: { type: Date },
    views: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
supportSchema.index({ shopId: 1, status: 1, createdAt: -1 });
supportSchema.plugin(tenantScoped);
export const SupportAccessModel = model('SupportAccess', supportSchema);

const ALL = { crossTenant: true } as const;
const HOUR = 60 * 60 * 1000;

type Doc = { _id: Types.ObjectId; shopId: Types.ObjectId; agentName: string; reason: string; hours: number; level: string; status: string; decidedBy?: string | null; decidedAt?: Date | null; startedAt?: Date | null; endsAt?: Date | null; endedAt?: Date | null; views?: number; createdAt?: Date };

/** "approved" past its end reads as ended — the clock closes it, nobody has to. */
const live = (d: Doc, now = new Date()) => (d.status === 'approved' && d.endsAt && d.endsAt <= now ? 'ended' : d.status);
const shape = (d: Doc, shopName = '') => ({ id: String(d._id), shopId: String(d.shopId), shopName, agentName: d.agentName, reason: d.reason, hours: d.hours, level: d.level, status: live(d), decidedBy: d.decidedBy ?? null, decidedAt: d.decidedAt ?? null, startedAt: d.startedAt ?? null, endsAt: d.endsAt ?? null, views: d.views ?? 0, createdAt: d.createdAt ?? null });

export async function request(a: AdminActor, shopId: string, hours: number, reason: string, ip?: string) {
  const shop = await ShopModel.findById(shopId).select('name').lean();
  if (!shop) throw AppError.notFound('Shop not found');
  const open = await SupportAccessModel.findOne({ shopId: shop._id, status: { $in: ['pending', 'approved'] }, $or: [{ status: 'pending' }, { endsAt: { $gt: new Date() } }] }).lean();
  if (open) throw AppError.conflict('There is already an open request for this shop');
  const d = await SupportAccessModel.create({ shopId: shop._id, adminUserId: new Types.ObjectId(a.id), agentName: a.name, reason, hours });
  await emit(shop._id, { key: `SUPPORT_ACCESS:${String(d._id)}`, type: 'SUPPORT_ACCESS', priority: 'high', title: `MedShop support asks to look at your shop for ${String(hours)} h`, body: `${a.name}: ${reason}. Approve or deny in Settings → Support access.`, route: '/settings/support', roles: ['owner'] });
  await AdminAuditModel.create({ adminUserId: new Types.ObjectId(a.id), adminName: a.name, shopId: shop._id, shopName: shop.name, action: 'support_request', reason, text: `asked for ${String(hours)} h of read-only support access`, ip });
  return shape(d.toObject(), shop.name);
}

export async function forAdmin(now = new Date()) {
  const rows = await SupportAccessModel.find({}).setOptions(ALL).sort({ createdAt: -1 }).limit(100).lean<Doc[]>();
  const names = new Map((await ShopModel.find({ _id: { $in: rows.map((r) => r.shopId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  return rows.map((r) => ({ ...shape(r, names.get(String(r.shopId)) ?? ''), status: live(r, now) }));
}

export async function forShop(t: TenantContext) {
  const rows = await SupportAccessModel.find({ shopId: t.shopId }).sort({ createdAt: -1 }).limit(50).lean<Doc[]>();
  return rows.map((r) => shape(r, t.shopName));
}

/** The owner's yes / no / stop (owner only — the person who agreed to the Terms). */
export async function decide(t: TenantContext, actor: Actor, id: string, decision: 'approve' | 'deny' | 'revoke', ip?: string) {
  if (!t.isOwner) throw AppError.forbidden('Only the shop owner decides on MedShop support access');
  const d = await SupportAccessModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) });
  if (!d) throw AppError.notFound('Request not found');
  const now = new Date();
  if (decision === 'revoke') {
    if (live(d.toObject(), now) !== 'approved') throw AppError.conflict('This access is not running');
    d.set({ status: 'revoked', endedAt: now, decidedBy: actor.name });
  } else {
    if (d.status !== 'pending') throw AppError.conflict('Already decided');
    d.set(decision === 'approve' ? { status: 'approved', decidedBy: actor.name, decidedAt: now, startedAt: now, endsAt: new Date(now.getTime() + d.hours * HOUR) } : { status: 'denied', decidedBy: actor.name, decidedAt: now });
  }
  await d.save();
  const verb = decision === 'approve' ? `let MedShop support (${d.agentName}) look for ${String(d.hours)} h` : decision === 'deny' ? `said no to MedShop support (${d.agentName})` : `stopped MedShop support access (${d.agentName})`;
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'permission_change', module: 'settings', entityId: id, entityName: 'Support access', text: `${actor.name} ${verb}`, ip });
  return shape(d.toObject(), t.shopName);
}

/** Only while approved and before its end, only the one who asked; each look is on both logs. */
export async function runReport(a: AdminActor, id: string, key: string, p: Params, ip?: string) {
  const d = await SupportAccessModel.findOne({ _id: new Types.ObjectId(id) }).setOptions(ALL).lean<Doc & { adminUserId: Types.ObjectId }>();
  if (!d || String(d.adminUserId) !== a.id) throw AppError.notFound('Support access not found');
  if (live(d) !== 'approved') throw AppError.forbidden('This support access is not running — ask the owner again');
  const r = reportByKey(key);
  if (!r) throw AppError.notFound('Report not found');
  const shop = await ShopModel.findById(d.shopId).select('name ownerUserId').lean();
  if (!shop) throw AppError.notFound('Shop not found');
  const { ctx } = await contextFor(d.shopId, shop.ownerUserId);
  const rows = await r.rows(ctx, p);
  await SupportAccessModel.updateOne({ shopId: d.shopId, _id: d._id }, { $inc: { views: 1 } });
  await audit({ shopId: d.shopId, userId: a.id, userName: `MedShop Support · ${a.name}`, action: 'share_initiated', module: 'reports', entityId: id, entityName: r.name, text: `MedShop Support (${a.name}) viewed ${r.name}`, ip });
  await AdminAuditModel.create({ adminUserId: new Types.ObjectId(a.id), adminName: a.name, shopId: d.shopId, shopName: shop.name, action: 'support_view', reason: d.reason, text: `viewed ${r.name} (support access)`, ip });
  const total = rows.at(-1)?.__total ? rows.at(-1) : null;
  const body = total ? rows.slice(0, -1) : rows;
  return { name: r.name, cols: r.cols, rows: body.slice(0, 300), total: total ?? null, count: body.length, endsAt: d.endsAt ?? null };
}
