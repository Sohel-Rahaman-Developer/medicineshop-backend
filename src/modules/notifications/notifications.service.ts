import { Types, type ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { istDayStart } from '../../utils/date';
import { audit } from '../audit/audit.model';
import { can, type Action, type Module } from '../rbac/permissions';
import { ShopModel } from '../shops/shop.model';
import type { Actor } from '../user/actor';
import { DEFAULT_ALERT_DAYS, expiryWindows } from './alerts.service';
import { liveAlerts, type Alert } from './alerts.service';
import { NOTIFICATION_TYPES, typeInfo, type Channel, type NotificationType, type Priority } from './notification.catalog';
import { NotificationModel, NotificationPrefModel, NotificationStateModel } from './notification.model';
import type { AlertSettingsInput, PrefsInput } from './notifications.validation';

const DAY = 24 * 60 * 60 * 1000;
const RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface EventInput {
  key: string;
  type: NotificationType;
  priority: Priority;
  title: string;
  body: string;
  route: string;
  roles?: string[];
  perm?: { module: Module; action: Action };
}

/** A one-off event (tier up, big discount), in the caller's transaction; the same key twice is one event. */
export async function emit(shopId: Types.ObjectId, e: EventInput, session?: ClientSession) {
  await NotificationModel.updateOne({ shopId, key: e.key }, { $setOnInsert: { ...e, roles: e.roles ?? [], shopId } }, { upsert: true, ...(session ? { session } : {}) });
}

async function events(t: TenantContext): Promise<Alert[]> {
  const rows = await NotificationModel.find({ shopId: t.shopId, createdAt: { $gte: new Date(Date.now() - 30 * DAY) } }).sort({ createdAt: -1 }).limit(100).lean();
  const role = t.isOwner ? 'owner' : (t.roleKey ?? '');
  return rows
    .filter((x) => (!x.roles.length || x.roles.includes(role)) && (!x.perm?.module || can(t.permissions, x.perm.module as Module, (x.perm.action ?? 'view') as Action)))
    .map((x) => ({ key: x.key, type: x.type, group: typeInfo(x.type).group, priority: x.priority, title: x.title, body: x.body, route: x.route, action: 'Open', items: [], at: (x as { createdAt?: Date }).createdAt ?? new Date() }));
}

/** What this person has switched off; critical (locked) types never are. */
export async function offFor(shopId: Types.ObjectId, userId: Types.ObjectId) {
  const p = await NotificationPrefModel.findOne({ shopId, userId }).lean();
  return new Set((p?.off ?? []).filter((o) => !typeInfo(o.kind).locked).map((o) => `${o.kind}:${o.channel}`));
}

export const wants = (off: Set<string>, type: NotificationType, channel: Channel) => typeInfo(type).locked || (typeInfo(type).channels.includes(channel) && !off.has(`${type}:${channel}`));

/** The bell and S72: live alerts + events, minus switched-off types; unread first, then priority, then newest. */
export async function list(t: TenantContext, userId: string, o: { all?: boolean; now?: Date } = {}) {
  const now = o.now ?? new Date();
  const uid = new Types.ObjectId(userId);
  const [live, ev, off] = await Promise.all([liveAlerts(t, now), events(t), offFor(t.shopId, uid)]);
  const shown = [...live, ...ev].filter((a) => wants(off, a.type, 'inapp'));
  const states = await NotificationStateModel.find({ shopId: t.shopId, userId: uid, key: { $in: shown.map((a) => a.key) } }).lean();
  const st = new Map(states.map((s) => [s.key, s]));
  const items = shown.map((a) => {
    const s = st.get(a.key);
    const snoozed = a.priority !== 'critical' && s?.snoozedUntil && s.snoozedUntil > now ? s.snoozedUntil : null;
    return { ...a, unread: !s?.readAt, snoozedUntil: snoozed };
  });
  items.sort((a, b) => Number(b.unread) - Number(a.unread) || RANK[a.priority] - RANK[b.priority] || b.at.getTime() - a.at.getTime());
  const visible = o.all ? items : items.filter((x) => !x.snoozedUntil);
  const open = items.filter((x) => !x.snoozedUntil);
  return { items: visible, unread: open.filter((x) => x.unread).length, urgent: open.filter((x) => x.unread && (x.priority === 'critical' || x.priority === 'high')).length, snoozed: items.length - open.length };
}

export async function markRead(t: TenantContext, userId: string, keys: string[] | 'all') {
  const uid = new Types.ObjectId(userId);
  const list_ = keys === 'all' ? (await list(t, userId)).items.filter((x) => x.unread).map((x) => x.key) : keys;
  if (!list_.length) return { read: 0 };
  const now = new Date();
  await NotificationStateModel.bulkWrite(list_.map((key) => ({ updateOne: { filter: { shopId: t.shopId, userId: uid, key }, update: { $set: { readAt: now } }, upsert: true } })));
  return { read: list_.length };
}

/** "Later": hidden until 9 AM IST tomorrow; a critical alert can't be put off (sandbox S.snooze). */
export async function snooze(t: TenantContext, userId: string, key: string, now = new Date()) {
  const found = (await list(t, userId, { all: true, now })).items.find((x) => x.key === key);
  if (!found) throw AppError.notFound('This alert is gone already');
  if (found.priority === 'critical') throw AppError.validation('A critical alert can’t be put off', [{ field: 'body.key', message: 'Critical' }]);
  const until = new Date(istDayStart(now).getTime() + DAY + 9 * 60 * 60 * 1000);
  await NotificationStateModel.updateOne({ shopId: t.shopId, userId: new Types.ObjectId(userId), key }, { $set: { snoozedUntil: until } }, { upsert: true });
  return { key, until };
}

export async function unsnooze(t: TenantContext, userId: string, key: string) {
  await NotificationStateModel.updateOne({ shopId: t.shopId, userId: new Types.ObjectId(userId), key }, { $unset: { snoozedUntil: 1 } });
  return { key };
}

/** S72 preferences: every type with its channels; locked ones always on. */
export async function prefs(t: TenantContext, userId: string) {
  const off = await offFor(t.shopId, new Types.ObjectId(userId));
  return NOTIFICATION_TYPES.map((type) => {
    const i = typeInfo(type);
    return { type, label: i.label, group: i.group, locked: Boolean(i.locked), channels: i.channels, inapp: wants(off, type, 'inapp'), email: wants(off, type, 'email') };
  });
}

export async function savePrefs(t: TenantContext, userId: string, input: PrefsInput) {
  const off = input.off.filter((o) => !typeInfo(o.kind).locked && (typeInfo(o.kind).channels as readonly Channel[]).includes(o.channel));
  await NotificationPrefModel.updateOne({ shopId: t.shopId, userId: new Types.ObjectId(userId) }, { $set: { off } }, { upsert: true });
  return prefs(t, userId);
}

/** The shop's alert days and mail times (Settings → Inventory); windows shown so the owner sees what each alert covers. */
export async function alertSettings(t: TenantContext) {
  const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings.inventory.expiryAlertDays settings.notifications').lean();
  const days = shop?.settings.inventory?.expiryAlertDays;
  const n = shop?.settings.notifications;
  const expiryAlertDays = [...(days?.length ? days : DEFAULT_ALERT_DAYS)].sort((a, b) => b - a);
  return {
    expiryAlertDays,
    alertDigestTime: n?.alertDigestTime ?? '08:00',
    dailySummaryTime: n?.dailySummaryTime ?? '22:00',
    emailEnabled: n?.emailEnabled ?? true,
    windows: expiryWindows(expiryAlertDays).map((w) => ({ type: w.type, priority: w.priority, what: w.what })),
  };
}

export async function saveAlertSettings(t: TenantContext, actor: Actor, input: AlertSettingsInput, ip?: string) {
  const before = await alertSettings(t);
  const days = [...input.expiryAlertDays].sort((a, b) => b - a);
  await ShopModel.updateOne(
    { _id: t.shopId },
    { $set: { 'settings.inventory.expiryAlertDays': days, 'settings.notifications.alertDigestTime': input.alertDigestTime, 'settings.notifications.dailySummaryTime': input.dailySummaryTime, 'settings.notifications.emailEnabled': input.emailEnabled } },
  );
  const what = [
    before.expiryAlertDays.join('/') !== days.join('/') ? `expiry alerts ${before.expiryAlertDays.join('/')} → ${days.join('/')} days` : '',
    before.alertDigestTime !== input.alertDigestTime ? `digest ${before.alertDigestTime} → ${input.alertDigestTime}` : '',
    before.dailySummaryTime !== input.dailySummaryTime ? `summary ${before.dailySummaryTime} → ${input.dailySummaryTime}` : '',
    before.emailEnabled !== input.emailEnabled ? (input.emailEnabled ? 'alert email on' : 'alert email off') : '',
  ].filter(Boolean);
  if (what.length) await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'settings', entityId: String(t.shopId), entityName: 'Alert settings', text: `${actor.name} changed ${what.join(' · ')}`, ip });
  return alertSettings(t);
}
