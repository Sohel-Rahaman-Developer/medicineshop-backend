import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inr } from '../../utils/money';
import { log } from '../admin/admin.service';
import type { AdminActor } from '../admin/admin-auth';
import { PlatformSettingsModel } from '../admin/admin.model';
import { audit } from '../audit/audit.model';
import { emit } from '../notifications/notifications.service';
import { ShopModel } from '../shops/shop.model';
import { logoPathOf } from '../shops/shop-logo';
import { SubscriptionModel, statusAt, type SubscriptionStatus } from '../subscription/subscription.model';
import { UserModel } from '../user/user.model';
import type { Actor } from '../user/actor';
import { WebAddressModel, WebAddressPaymentModel, type AddressStatus } from './web-address.model';

const DAY = 86_400_000;
const ALL = { crossTenant: true } as const;
/** A lapsed name waits this long for its shop before another shop may take it (D94). */
const KEEP_DAYS = 60;
const OPEN: AddressStatus[] = ['requested', 'active', 'stopped'];

// Names that are ours, or that would confuse a customer.
const RESERVED = new Set(['www', 'api', 'admin', 'app', 'apps', 'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'ns1', 'ns2', 'dns', 'cdn', 'static', 'assets', 'img', 'images', 'files', 'demo', 'help', 'support', 'status', 'blog', 'docs', 'dev', 'test', 'staging', 'beta', 'login', 'signin', 'signup', 'account', 'billing', 'pay', 'payments', 'shop', 'shops', 'store', 'partner', 'partners', 'field', 'medbox', 'medbox24', 'medshop', 'official', 'secure', 'root', 'system']);
export const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,28}[a-z0-9]$/;

const base = new URL(env.SHOP_APP_URL);
export const addressUrl = (slug: string) => `${base.protocol}//${slug}.${base.host}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// eslint-disable-next-line security/detect-non-literal-regexp -- built once from our own SHOP_APP_URL, escaped
const ORIGIN = new RegExp(`^${escape(base.protocol)}//([a-z0-9-]{3,30})\\.${escape(base.host)}$`);

/** Why a name can't be had, in words; null when it is fine to ask for. */
export function nameProblem(slug: string): string | null {
  if (slug.length < 3) return 'At least 3 letters';
  if (slug.length > 30) return 'At most 30 letters';
  if (!SLUG.test(slug)) return 'Use only small letters, numbers and single hyphens — not at the start or end';
  if (RESERVED.has(slug)) return 'This name is kept for MedBox24';
  return null;
}

type Rec = { _id: Types.ObjectId; shopId: Types.ObjectId; slug: string; status: AddressStatus; freeUntil?: Date | null; paidUntil?: Date | null; decidedAt?: Date | null };
type Sub = { status: SubscriptionStatus; planCode: string; endDate: Date } | null;

const after = (a?: Date | null, now = new Date()) => Boolean(a && a > now);

/** Live: approved, the shop open, its plan running, and either still in the trial or the add-on paid or given free. */
function liveAt(r: Rec, shopStatus: string, sub: Sub, now: Date) {
  if (r.status !== 'active' || shopStatus !== 'active' || !sub) return false;
  const plan = statusAt(sub, now);
  if (plan === 'expired' || plan === 'cancelled') return false;
  return plan === 'trial' || after(r.freeUntil, now) || after(r.paidUntil, now);
}

/** When the address last worked (or will stop): the end of the trial, the free time or the paid time. */
function lastLiveOf(r: Rec, sub: Sub): Date | null {
  const ends = [sub?.planCode === 'trial' ? sub.endDate : null, r.freeUntil ?? null, r.paidUntil ?? null].filter((d): d is Date => d instanceof Date);
  return ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;
}

export async function stateOf(r: Rec, now = new Date()) {
  const [shop, sub] = await Promise.all([ShopModel.findById(r.shopId).select('name status').lean(), SubscriptionModel.findOne({ shopId: r.shopId }).select('status planCode endDate').lean()]);
  return { shop, sub, live: liveAt(r, shop?.status ?? 'closed', sub, now), lastLive: lastLiveOf(r, sub) };
}

/** Another shop's name that lapsed long ago may be taken; anything else open is taken. */
async function holderOf(slug: string, shopId: Types.ObjectId, now: Date) {
  const r = await WebAddressModel.findOne({ slug, status: { $in: OPEN } }, null, ALL).lean<Rec>();
  if (!r || r.shopId.equals(shopId)) return null;
  if (r.status === 'requested') return r;
  const s = await stateOf(r, now);
  if (s.live) return r;
  const since = r.status === 'stopped' ? (r.decidedAt ?? null) : s.lastLive;
  return since && now.getTime() - since.getTime() > KEEP_DAYS * DAY ? { ...r, lapsed: true as const } : r;
}

export async function prices(): Promise<{ month: number | null; year: number | null }> {
  const s = await PlatformSettingsModel.findById('platform').select('webAddressPrice webAddressYearPrice').lean();
  return { month: s?.webAddressPrice ?? null, year: s?.webAddressPrice ? (s.webAddressYearPrice ?? null) : null };
}

async function shapeMine(r: Rec & { reason?: string; requestedAt: Date }, now: Date) {
  const s = await stateOf(r, now);
  return { id: String(r._id), name: r.slug, url: addressUrl(r.slug), status: r.status, live: s.live, reason: r.reason ?? '', requestedAt: r.requestedAt, freeUntil: r.freeUntil ?? null, paidUntil: r.paidUntil ?? null, trialEnds: s.sub?.planCode === 'trial' ? s.sub.endDate : null };
}

/** Settings → Web address: the shop's address (or its last answer), the price and the domain it sits under. */
export async function mine(t: TenantContext, now = new Date()) {
  const r = await WebAddressModel.findOne({ shopId: t.shopId, status: { $ne: 'released' } }).sort({ requestedAt: -1 }).lean<Rec & { reason?: string; requestedAt: Date }>();
  const p = await prices();
  return { address: r ? await shapeMine(r, now) : null, price: p.month, yearPrice: p.year, domain: base.host };
}

const clean = (name: string) => name.trim().toLowerCase();
const takenProblem = () => 'Another shop has this name';

export async function check(t: TenantContext, name: string, now = new Date()) {
  const slug = clean(name);
  const problem = nameProblem(slug);
  if (problem) return { name: slug, ok: false, why: problem };
  const h = await holderOf(slug, t.shopId, now);
  return h && !('lapsed' in h) ? { name: slug, ok: false, why: takenProblem() } : { name: slug, ok: true, why: '' };
}

/** The owner asks for a name; while it waits it can still be changed. An approved address is changed by the team. */
export async function request(t: TenantContext, actor: Actor, name: string, ip?: string, now = new Date()) {
  const slug = clean(name);
  const problem = nameProblem(slug);
  if (problem) throw AppError.validation(problem, [{ field: 'body.name', message: problem }]);
  const own = await WebAddressModel.findOne({ shopId: t.shopId, status: { $in: OPEN } }).lean<Rec>();
  if (own && own.status !== 'requested') throw AppError.conflict(`Your address is ${addressUrl(own.slug)} — call MedBox24 to change it`);
  const h = await holderOf(slug, t.shopId, now);
  if (h && !('lapsed' in h)) throw AppError.conflict('Another shop has this name — try another', { reason: 'TAKEN' });
  if (h) await WebAddressModel.updateOne({ _id: h._id, shopId: h.shopId }, { $set: { status: 'released' } });
  try {
    if (own) await WebAddressModel.updateOne({ _id: own._id, shopId: t.shopId }, { $set: { slug, requestedAt: now, requestedByName: actor.name } });
    else await WebAddressModel.create({ shopId: t.shopId, slug, status: 'requested', requestedAt: now, requestedByName: actor.name });
  } catch (err) {
    // Two shops asked for the same name at the same moment: the unique index lets one through.
    if ((err as { code?: number }).code === 11000) throw AppError.conflict('Another shop has this name — try another', { reason: 'TAKEN' });
    throw err;
  }
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: own ? 'update' : 'create', module: 'settings', entityId: slug, entityName: addressUrl(slug), text: `${actor.name} asked for the web address ${addressUrl(slug)}`, ip });
  return (await mine(t, now)).address;
}

/** A request not yet answered can be taken back. */
export async function withdraw(t: TenantContext, actor: Actor, ip?: string) {
  const r = await WebAddressModel.findOneAndDelete({ shopId: t.shopId, status: 'requested' }).lean<Rec>();
  if (!r) throw AppError.notFound('No request to take back');
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'settings', entityId: r.slug, entityName: addressUrl(r.slug), text: `${actor.name} took back the request for ${addressUrl(r.slug)}`, ip });
}

/** Admin → Web addresses: every open request and address, with whom to call. */
export async function adminList(now = new Date()) {
  const rows = await WebAddressModel.find({ status: { $in: ['requested', 'active', 'stopped', 'rejected'] } }, null, ALL).sort({ requestedAt: -1 }).limit(500).lean<(Rec & { reason?: string; requestedAt: Date; requestedByName: string; decidedByName?: string; notes: { text: string; byName: string; at: Date }[] })[]>();
  const shops = await ShopModel.find({ _id: { $in: rows.map((r) => r.shopId) } }, null, ALL).select('name phone address.city ownerUserId status').lean();
  const owners = await UserModel.find({ _id: { $in: shops.map((s) => s.ownerUserId) } }).select('name email').lean();
  const subs = await SubscriptionModel.find({ shopId: { $in: rows.map((r) => r.shopId) } }, null, ALL).select('shopId status planCode endDate').lean();
  const pays = await WebAddressPaymentModel.find({ addressId: { $in: rows.map((r) => r._id) }, status: 'paid' }).select('addressId period amount invoiceNumber periodEnd source reference paidAt').sort({ createdAt: -1 }).limit(1000).lean();
  const p = await prices();
  return {
    price: p.month,
    yearPrice: p.year,
    domain: base.host,
    rows: rows.map((r) => {
      const shop = shops.find((s) => s._id.equals(r.shopId));
      const owner = owners.find((o) => shop?.ownerUserId && o._id.equals(shop.ownerUserId));
      const sub = (subs.find((s) => s.shopId.equals(r.shopId)) ?? null) as Sub;
      return {
        id: String(r._id),
        name: r.slug,
        url: addressUrl(r.slug),
        status: r.status,
        live: liveAt(r, shop?.status ?? 'closed', sub, now),
        plan: sub ? statusAt(sub, now) : null,
        trialEnds: sub?.planCode === 'trial' ? sub.endDate : null,
        freeUntil: r.freeUntil ?? null,
        paidUntil: r.paidUntil ?? null,
        reason: r.reason ?? '',
        requestedAt: r.requestedAt,
        requestedByName: r.requestedByName,
        decidedByName: r.decidedByName ?? null,
        notes: r.notes.map((n) => ({ text: n.text, byName: n.byName, at: n.at })),
        shop: { id: String(r.shopId), name: shop?.name ?? '', city: shop?.address?.city ?? '', phone: shop?.phone ?? '' },
        owner: { name: owner?.name ?? '', email: owner?.email ?? '' },
        payments: pays.filter((x) => x.addressId.equals(r._id)).slice(0, 5).map((x) => ({ period: x.period, amount: x.amount, invoiceNumber: x.invoiceNumber ?? '', paidUntil: x.periodEnd ?? null, source: x.source, reference: x.reference ?? '', paidAt: x.paidAt ?? null })),
      };
    }),
  };
}

async function byId(id: string) {
  const r = await WebAddressModel.findOne({ _id: new Types.ObjectId(id) }, null, ALL).lean<Rec & { requestedAt: Date }>();
  if (!r) throw AppError.notFound('Web address not found');
  const shop = await ShopModel.findById(r.shopId).select('name').lean();
  return { r, shop: { id: r.shopId, name: shop?.name ?? '' } };
}

const NEXT: Record<'approve' | 'reject' | 'stop' | 'restart', { from: AddressStatus; to: AddressStatus; done: string }> = {
  approve: { from: 'requested', to: 'active', done: 'approved' },
  reject: { from: 'requested', to: 'rejected', done: 'turned down' },
  stop: { from: 'active', to: 'stopped', done: 'stopped' },
  restart: { from: 'stopped', to: 'active', done: 'started again' },
};

/** Approve or turn down a request, or stop / restart an address; the owner hears of it in the bell. */
export async function decide(a: AdminActor, id: string, action: keyof typeof NEXT, reason: string, ip?: string) {
  const { r, shop } = await byId(id);
  const step = NEXT[action];
  if (r.status !== step.from) throw AppError.conflict(`This address is ${r.status} — it can’t be ${step.done} now`);
  const now = new Date();
  const done = await WebAddressModel.updateOne({ _id: r._id, shopId: r.shopId, status: step.from }, { $set: { status: step.to, decidedAt: now, decidedByName: a.name, reason: action === 'reject' || action === 'stop' ? reason : '' } });
  if (!done.modifiedCount) throw AppError.conflict('It changed meanwhile — reload');
  forgetLive();
  await log(a, `web_address_${action}`, reason, `${step.done} the web address ${addressUrl(r.slug)}`, shop, undefined, ip);
  const url = addressUrl(r.slug);
  if (action === 'approve' || action === 'restart') await emit(r.shopId, { key: `WEB_ADDRESS:${String(r._id)}:${action}:${String(now.getTime())}`, type: 'WEB_ADDRESS', priority: 'medium', title: `Your web address ${url} is ready`, body: 'Your team can open the app at this address. Share it with them.', route: '/settings/web-address', roles: ['owner'] });
  else await emit(r.shopId, { key: `WEB_ADDRESS:${String(r._id)}:${action}:${String(now.getTime())}`, type: 'WEB_ADDRESS', priority: 'medium', title: action === 'reject' ? `MedBox24 did not approve ${url}` : `Your web address ${url} is stopped`, body: reason, route: '/settings/web-address', roles: ['owner'] });
  return (await adminList()).rows.find((x) => x.id === id);
}

/** The team gives the add-on free up to a day (null takes the gift back). */
export async function setFree(a: AdminActor, id: string, until: Date | null, reason: string, ip?: string) {
  const { r, shop } = await byId(id);
  await WebAddressModel.updateOne({ _id: r._id, shopId: r.shopId }, until ? { $set: { freeUntil: until } } : { $unset: { freeUntil: 1 } });
  forgetLive();
  await log(a, 'web_address_free', reason, until ? `gave ${addressUrl(r.slug)} free until ${until.toISOString().slice(0, 10)}` : `took back the free time on ${addressUrl(r.slug)}`, shop, undefined, ip);
  return (await adminList()).rows.find((x) => x.id === id);
}

/** Notes from the call (what was agreed, when to call back). */
export async function addNote(a: AdminActor, id: string, text: string) {
  const { r } = await byId(id);
  await WebAddressModel.updateOne({ _id: r._id, shopId: r.shopId }, { $push: { notes: { text, byName: a.name, at: new Date() } } });
  return (await adminList()).rows.find((x) => x.id === id);
}

const money = (p: number | null) => (p === null ? 'none' : inr(p));

/** A month's price, and a year's (only sold with a monthly price beside it). */
export async function setPrice(a: AdminActor, month: number | null, year: number | null, reason: string, ip?: string) {
  const before = await prices();
  const y = month === null ? null : year;
  const set: Record<string, number> = {};
  const unset: Record<string, 1> = {};
  if (month === null) unset.webAddressPrice = 1;
  else set.webAddressPrice = month;
  if (y === null) unset.webAddressYearPrice = 1;
  else set.webAddressYearPrice = y;
  await PlatformSettingsModel.updateOne({ _id: 'platform' }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
  await log(a, 'web_address_price', reason, `set the web address price ${money(before.month)} → ${money(month)} a month, ${money(before.year)} → ${money(y)} a year`, undefined, undefined, ip);
  return prices();
}

/** The address as anyone sees it: whether it opens, and whose it is (name and logo for the sign-in page). */
export async function publicAddress(slug: string, now = new Date()) {
  const r = SLUG.test(slug) ? await WebAddressModel.findOne({ slug, status: 'active' }, null, ALL).lean<Rec>() : null;
  if (!r) return { live: false, shopName: null, logo: null };
  const s = await stateOf(r, now);
  if (!s.live) return { live: false, shopName: null, logo: null };
  return { live: true, shopName: s.shop?.name ?? '', logo: await logoPathOf(r.shopId) };
}

/** The owner's bell: the address stops within 7 days, or stopped (less than 60 days ago) for want of the add-on. */
export async function endingOf(shopId: Types.ObjectId, now = new Date()) {
  const r = await WebAddressModel.findOne({ shopId, status: 'active' }).lean<Rec>();
  if (!r || (await prices()).month === null) return null;
  const s = await stateOf(r, now);
  const end = s.lastLive ?? r.decidedAt ?? null;
  if (!end) return null;
  const left = Math.ceil((end.getTime() - now.getTime()) / DAY);
  if (s.live ? left > 7 : left > 0 || -left > KEEP_DAYS) return null;
  return { url: addressUrl(r.slug), ends: end, left: Math.max(0, left), live: s.live };
}

// The API trusts a live address as one of its own apps (CORS, CSRF). Answers are kept 30 seconds per name.
const LIVE_TTL = 30_000;
const live = new Map<string, { ok: boolean; at: number }>();
export const forgetLive = () => { live.clear(); };

export async function isLiveOrigin(origin: string | undefined): Promise<boolean> {
  const slug = origin ? ORIGIN.exec(origin)?.[1] : undefined;
  if (!slug || !SLUG.test(slug)) return false;
  const hit = live.get(slug);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.ok;
  const ok = (await publicAddress(slug)).live;
  live.set(slug, { ok, at: Date.now() });
  return ok;
}
