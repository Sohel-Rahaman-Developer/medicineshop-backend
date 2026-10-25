import { resolve4 } from 'node:dns/promises';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inr } from '../../utils/money';
import { log } from '../admin/admin.service';
import type { AdminActor } from '../admin/admin-auth';
import { audit } from '../audit/audit.model';
import { emit } from '../notifications/notifications.service';
import { ShopModel } from '../shops/shop.model';
import { logoPathOf } from '../shops/shop-logo';
import { SubscriptionModel, statusAt, type SubscriptionStatus } from '../subscription/subscription.model';
import { UserModel } from '../user/user.model';
import type { Actor } from '../user/actor';
import type { AddressStatus } from '../webaddress/web-address.model';
import { WebAddressPaymentModel } from '../webaddress/web-address.model';
import { OwnDomainModel, type DomainKind } from './own-domain.model';

const DAY = 86_400_000;
const ALL = { crossTenant: true } as const;
const OPEN: AddressStatus[] = ['requested', 'active', 'stopped'];
const base = new URL(env.SHOP_APP_URL);
const ours = [base.hostname, new URL(env.ADMIN_APP_URL).hostname];

/** https://krishnamedical.in (the port only where the app itself runs on one, as in tests). */
export const domainUrl = (domain: string) => `${base.protocol}//${domain}${base.port ? `:${base.port}` : ''}`;

/** "https://www.Krishna-Medical.in/login" → "krishna-medical.in". */
export const cleanDomain = (raw: string) => raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^www\./, '').replace(/\.$/, '');
/** One part of a name: 1–63 small letters, numbers or hyphens, not starting or ending with a hyphen. */
const label = (p: string) => p.length >= 1 && p.length <= 63 && /^[a-z0-9-]+$/.test(p) && !p.startsWith('-') && !p.endsWith('-');

/** Why a domain can't be used, in words; null when it is fine. */
export function domainProblem(domain: string): string | null {
  const parts = domain.split('.');
  if (domain.length < 4 || parts.length < 2) return 'Type the full domain, like krishnamedical.in';
  if (domain.length > 253 || !parts.every(label) || !/^[a-z]{2,24}$/.test(parts.at(-1) ?? '')) return 'This is not a domain — use letters, numbers and hyphens, like krishnamedical.in';
  if (ours.some((h) => domain === h || domain.endsWith(`.${h}`))) return 'This is a MedBox24 address — ask for it under Web address';
  return null;
}

type Rec = { _id: Types.ObjectId; shopId: Types.ObjectId; domain: string; kind: DomainKind; status: AddressStatus; freeUntil?: Date | null; paidUntil?: Date | null; buyPrice?: number | null; domainPaidUntil?: Date | null; dnsOk?: boolean; dnsCheckedAt?: Date | null; decidedAt?: Date | null; reason?: string; requestedAt: Date; requestedByName: string };
type Sub = { status: SubscriptionStatus; planCode: string; endDate: Date } | null;
const after = (a?: Date | null, now = new Date()) => Boolean(a && a > now);

/** Live: switched on, the shop open, its plan running, the add-on in its trial / free / paid time, and a bought name paid. */
function liveAt(r: Rec, shopStatus: string, sub: Sub, now: Date) {
  if (r.status !== 'active' || shopStatus !== 'active' || !sub) return false;
  const plan = statusAt(sub, now);
  if (plan === 'expired' || plan === 'cancelled') return false;
  if (r.kind === 'buy' && !after(r.domainPaidUntil, now)) return false;
  return plan === 'trial' || after(r.freeUntil, now) || after(r.paidUntil, now);
}

function lastLiveOf(r: Rec, sub: Sub): Date | null {
  const ends = [sub?.planCode === 'trial' ? sub.endDate : null, r.freeUntil ?? null, r.paidUntil ?? null].filter((d): d is Date => d instanceof Date);
  return ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;
}

export async function domainStateOf(r: Rec, now = new Date()) {
  const [shop, sub] = await Promise.all([ShopModel.findById(r.shopId).select('name status').lean(), SubscriptionModel.findOne({ shopId: r.shopId }).select('status planCode endDate').lean()]);
  return { shop, sub, live: liveAt(r, shop?.status ?? 'closed', sub, now), lastLive: lastLiveOf(r, sub) };
}

// DNS: the name (and www) must point at this server. Tests swap the lookup for a stand-in.
let lookup: (host: string) => Promise<string[]> = (host) => resolve4(host).catch(() => []);
export const setDnsLookup = (fn: (host: string) => Promise<string[]>) => { lookup = fn; };
const serverIps = async () => lookup(base.hostname);

async function dnsOf(domain: string) {
  const [want, bare, www] = await Promise.all([serverIps(), lookup(domain), lookup(`www.${domain}`)]);
  const points = (ips: string[]) => ips.length > 0 && ips.every((ip) => want.includes(ip));
  return { ip: want[0] ?? '', bare: points(bare), www: points(www), ok: points(bare) && points(www), seen: { bare, www } };
}

async function shape(r: Rec, now: Date) {
  const s = await domainStateOf(r, now);
  return {
    id: String(r._id),
    domain: r.domain,
    url: domainUrl(r.domain),
    kind: r.kind,
    status: r.status,
    live: s.live,
    reason: r.reason ?? '',
    requestedAt: r.requestedAt,
    freeUntil: r.freeUntil ?? null,
    paidUntil: r.paidUntil ?? null,
    trialEnds: s.sub?.planCode === 'trial' ? s.sub.endDate : null,
    buyPrice: r.buyPrice ?? null,
    domainPaidUntil: r.domainPaidUntil ?? null,
    dnsOk: r.dnsOk === true,
    dnsCheckedAt: r.dnsCheckedAt ?? null,
  };
}

/** Settings → Web address → Your own domain: the request or domain, and where its DNS must point. */
export async function mineDomain(t: TenantContext, now = new Date()) {
  const r = await OwnDomainModel.findOne({ shopId: t.shopId, status: { $ne: 'released' } }).sort({ requestedAt: -1 }).lean<Rec>();
  return { domain: r ? await shape(r, now) : null, serverIp: (await serverIps())[0] ?? '' };
}

/** The owner asks: a domain the shop has, or one for MedBox24 to buy. While it waits it can be changed. */
export async function requestDomain(t: TenantContext, actor: Actor, input: { domain: string; kind: DomainKind }, ip?: string, now = new Date()) {
  const domain = cleanDomain(input.domain);
  const problem = domainProblem(domain);
  if (problem) throw AppError.validation(problem, [{ field: 'body.domain', message: problem }]);
  const own = await OwnDomainModel.findOne({ shopId: t.shopId, status: { $in: OPEN } }).lean<Rec>();
  if (own && own.status !== 'requested') throw AppError.conflict(`Your domain is ${own.domain} — call MedBox24 to change it`);
  const other = await OwnDomainModel.findOne({ domain, status: { $in: OPEN }, shopId: { $ne: t.shopId } }, null, ALL).lean<Rec>();
  if (other) throw AppError.conflict('Another shop has asked for this domain', { reason: 'TAKEN' });
  try {
    if (own) await OwnDomainModel.updateOne({ _id: own._id, shopId: t.shopId }, { $set: { domain, kind: input.kind, requestedAt: now, requestedByName: actor.name, dnsOk: false }, $unset: { buyPrice: 1, dnsCheckedAt: 1 } });
    else await OwnDomainModel.create({ shopId: t.shopId, domain, kind: input.kind, status: 'requested', requestedAt: now, requestedByName: actor.name });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw AppError.conflict('Another shop has asked for this domain', { reason: 'TAKEN' });
    throw err;
  }
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: own ? 'update' : 'create', module: 'settings', entityId: domain, entityName: domain, text: `${actor.name} asked for the own domain ${domain} (${input.kind === 'buy' ? 'MedBox24 to buy it' : 'the shop has it'})`, ip });
  return (await mineDomain(t, now)).domain;
}

export async function withdrawDomain(t: TenantContext, actor: Actor, ip?: string) {
  const r = await OwnDomainModel.findOne({ shopId: t.shopId, status: 'requested' }).lean<Rec>();
  if (!r) throw AppError.notFound('No request to take back');
  if (r.domainPaidUntil) throw AppError.conflict('The domain is paid for — call MedBox24');
  await OwnDomainModel.deleteOne({ _id: r._id, shopId: t.shopId });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'delete', module: 'settings', entityId: r.domain, entityName: r.domain, text: `${actor.name} took back the request for ${r.domain}`, ip });
}

async function saveDns(r: Rec, now: Date) {
  const d = await dnsOf(r.domain);
  await OwnDomainModel.updateOne({ _id: r._id, shopId: r.shopId }, { $set: { dnsOk: d.ok, dnsCheckedAt: now } });
  return d;
}

/** "Check now": does the name (and www) point at MedBox24 yet? */
export async function checkDns(t: TenantContext, now = new Date()) {
  const r = await OwnDomainModel.findOne({ shopId: t.shopId, status: { $in: OPEN } }).lean<Rec>();
  if (!r) throw AppError.notFound('Ask for a domain first');
  const d = await saveDns(r, now);
  return { ok: d.ok, bare: d.bare, www: d.www, serverIp: d.ip, checkedAt: now };
}

// Live answers per host for 30 seconds (CORS, CSRF, the sign-in page); a change by the team clears them.
const LIVE_TTL = 30_000;
const live = new Map<string, { shop: string | null; at: number }>();
export const forgetLiveDomains = () => { live.clear(); };

async function liveShopOfDomain(domain: string): Promise<string | null> {
  const hit = live.get(domain);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.shop;
  const r = domainProblem(domain) ? null : await OwnDomainModel.findOne({ domain, status: 'active' }, null, ALL).lean<Rec>();
  const shop = r && (await domainStateOf(r)).live ? String(r.shopId) : null;
  live.set(domain, { shop, at: Date.now() });
  return shop;
}

/** The shop whose live own domain this origin is (with or without www); null otherwise. */
export async function shopOfDomainOrigin(origin: string | undefined): Promise<string | null> {
  if (!origin) return null;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== base.protocol || u.port !== base.port || u.pathname !== '/' || u.username || u.search) return null;
  const domain = cleanDomain(u.hostname);
  return domainProblem(domain) ? null : liveShopOfDomain(domain);
}

/** The sign-in page on a domain: whether it opens, and whose it is. */
export async function publicDomain(host: string) {
  const domain = cleanDomain(host);
  const shopId = domainProblem(domain) ? null : await liveShopOfDomain(domain);
  if (!shopId) return { live: false, shopName: null, logo: null };
  const shop = await ShopModel.findById(shopId).select('name').lean();
  return { live: true, shopName: shop?.name ?? '', logo: await logoPathOf(new Types.ObjectId(shopId)) };
}

/** Each shop's live own domain, for the app to open the shop there. */
export async function liveDomains(shopIds: Types.ObjectId[]): Promise<Map<string, string>> {
  if (!shopIds.length) return new Map();
  const rs = await OwnDomainModel.find({ shopId: { $in: shopIds }, status: 'active' }, null, ALL).select('shopId domain').lean<Rec[]>();
  const out = new Map<string, string>();
  await Promise.all(rs.map(async (r) => { if ((await liveShopOfDomain(r.domain)) === String(r.shopId)) out.set(String(r.shopId), domainUrl(r.domain)); }));
  return out;
}

/** The owner's bell: the add-on or a bought name runs out within 7 / 30 days. */
export async function domainEndingOf(shopId: Types.ObjectId, now = new Date()) {
  const r = await OwnDomainModel.findOne({ shopId, status: 'active' }).lean<Rec>();
  if (!r) return null;
  const left = (d?: Date | null) => (d ? Math.ceil((d.getTime() - now.getTime()) / DAY) : null);
  const name = left(r.kind === 'buy' ? r.domainPaidUntil : null);
  if (name !== null && name <= 30) return { domain: r.domain, what: 'name' as const, left: Math.max(0, name), ends: r.domainPaidUntil ?? now };
  return null;
}

/** Admin → Web addresses → Own domains. */
export async function adminDomains(now = new Date()) {
  const rows = await OwnDomainModel.find({ status: { $in: ['requested', 'active', 'stopped', 'rejected'] } }, null, ALL).sort({ requestedAt: -1 }).limit(500).lean<(Rec & { decidedByName?: string; notes: { text: string; byName: string; at: Date }[] })[]>();
  const shops = await ShopModel.find({ _id: { $in: rows.map((r) => r.shopId) } }, null, ALL).select('name phone address.city ownerUserId status').lean();
  const owners = await UserModel.find({ _id: { $in: shops.map((s) => s.ownerUserId) } }).select('name email').lean();
  const subs = await SubscriptionModel.find({ shopId: { $in: rows.map((r) => r.shopId) } }, null, ALL).select('shopId status planCode endDate').lean();
  const pays = await WebAddressPaymentModel.find({ addressId: { $in: rows.map((r) => r._id) }, target: 'domain', status: 'paid' }).select('addressId what period amount invoiceNumber periodEnd source reference paidAt').sort({ createdAt: -1 }).limit(1000).lean();
  return rows.map((r) => {
    const shop = shops.find((s) => s._id.equals(r.shopId));
    const owner = owners.find((o) => shop?.ownerUserId && o._id.equals(shop.ownerUserId));
    const sub = (subs.find((s) => s.shopId.equals(r.shopId)) ?? null) as Sub;
    return {
      id: String(r._id),
      domain: r.domain,
      url: domainUrl(r.domain),
      kind: r.kind,
      status: r.status,
      live: liveAt(r, shop?.status ?? 'closed', sub, now),
      plan: sub ? statusAt(sub, now) : null,
      trialEnds: sub?.planCode === 'trial' ? sub.endDate : null,
      freeUntil: r.freeUntil ?? null,
      paidUntil: r.paidUntil ?? null,
      buyPrice: r.buyPrice ?? null,
      domainPaidUntil: r.domainPaidUntil ?? null,
      dnsOk: r.dnsOk === true,
      dnsCheckedAt: r.dnsCheckedAt ?? null,
      reason: r.reason ?? '',
      requestedAt: r.requestedAt,
      requestedByName: r.requestedByName,
      decidedByName: r.decidedByName ?? null,
      notes: r.notes.map((n) => ({ text: n.text, byName: n.byName, at: n.at })),
      shop: { id: String(r.shopId), name: shop?.name ?? '', city: shop?.address?.city ?? '', phone: shop?.phone ?? '' },
      owner: { name: owner?.name ?? '', email: owner?.email ?? '' },
      payments: pays.filter((x) => x.addressId.equals(r._id)).slice(0, 5).map((x) => ({ what: x.what, period: x.period, amount: x.amount, invoiceNumber: x.invoiceNumber ?? '', paidUntil: x.periodEnd ?? null, source: x.source, reference: x.reference ?? '', paidAt: x.paidAt ?? null })),
    };
  });
}

async function byId(id: string) {
  const r = await OwnDomainModel.findOne({ _id: new Types.ObjectId(id) }, null, ALL).lean<Rec>();
  if (!r) throw AppError.notFound('Domain not found');
  const shop = await ShopModel.findById(r.shopId).select('name').lean();
  return { r, shop: { id: r.shopId, name: shop?.name ?? '' } };
}
const rowOf = async (id: string) => (await adminDomains()).find((x) => x.id === id);

const NEXT: Record<'approve' | 'reject' | 'stop' | 'restart', { from: AddressStatus; to: AddressStatus; done: string }> = {
  approve: { from: 'requested', to: 'active', done: 'switched on' },
  reject: { from: 'requested', to: 'rejected', done: 'turned down' },
  stop: { from: 'active', to: 'stopped', done: 'stopped' },
  restart: { from: 'stopped', to: 'active', done: 'started again' },
};

/** Switch on only when the DNS points here and a bought name is paid; the owner hears of every answer. */
export async function decideDomain(a: AdminActor, id: string, action: keyof typeof NEXT, reason: string, ip?: string, now = new Date()) {
  const { r, shop } = await byId(id);
  const step = NEXT[action];
  if (r.status !== step.from) throw AppError.conflict(`This domain is ${r.status} — it can’t be ${step.done} now`);
  if (action === 'approve' || action === 'restart') {
    if (r.kind === 'buy' && !after(r.domainPaidUntil, now)) throw AppError.conflict('The shop has not paid for the domain yet');
    if (!(await saveDns(r, now)).ok) throw AppError.conflict(`${r.domain} and www.${r.domain} don’t point to this server yet — check the DNS`);
  }
  const done = await OwnDomainModel.updateOne({ _id: r._id, shopId: r.shopId, status: step.from }, { $set: { status: step.to, decidedAt: now, decidedByName: a.name, reason: action === 'reject' || action === 'stop' ? reason : '' } });
  if (!done.modifiedCount) throw AppError.conflict('It changed meanwhile — reload');
  forgetLiveDomains();
  await log(a, `own_domain_${action}`, reason, `${step.done} the own domain ${r.domain}`, shop, undefined, ip);
  const key = `OWN_DOMAIN:${String(r._id)}:${action}:${String(now.getTime())}`;
  if (action === 'approve' || action === 'restart') await emit(r.shopId, { key, type: 'WEB_ADDRESS', priority: 'medium', title: `Your domain ${r.domain} is ready`, body: 'Your team can open the app at this address. Share it with them.', route: '/settings/web-address', roles: ['owner'] });
  else await emit(r.shopId, { key, type: 'WEB_ADDRESS', priority: 'medium', title: action === 'reject' ? `MedBox24 did not set up ${r.domain}` : `Your domain ${r.domain} is stopped`, body: reason, route: '/settings/web-address', roles: ['owner'] });
  return rowOf(id);
}

export async function setDomainFree(a: AdminActor, id: string, until: Date | null, reason: string, ip?: string) {
  const { r, shop } = await byId(id);
  await OwnDomainModel.updateOne({ _id: r._id, shopId: r.shopId }, until ? { $set: { freeUntil: until } } : { $unset: { freeUntil: 1 } });
  forgetLiveDomains();
  await log(a, 'own_domain_free', reason, until ? `gave the add-on on ${r.domain} free until ${until.toISOString().slice(0, 10)}` : `took back the free time on ${r.domain}`, shop, undefined, ip);
  return rowOf(id);
}

/** "buy": the name's yearly price after the call — never free; the owner is told to pay it in the app. */
export async function setBuyPrice(a: AdminActor, id: string, price: number, reason: string, ip?: string, now = new Date()) {
  const { r, shop } = await byId(id);
  if (r.kind !== 'buy') throw AppError.conflict('The shop has this domain already — there is nothing to buy');
  await OwnDomainModel.updateOne({ _id: r._id, shopId: r.shopId }, { $set: { buyPrice: price } });
  await log(a, 'own_domain_price', reason, `set ${inr(price)} a year to buy ${r.domain}`, shop, undefined, ip);
  await emit(r.shopId, { key: `OWN_DOMAIN:${String(r._id)}:price:${String(now.getTime())}`, type: 'WEB_ADDRESS', priority: 'medium', title: `${r.domain} costs ${inr(price)} a year`, body: 'Pay for it in Settings → Web address; MedBox24 then buys it and sets it up.', route: '/settings/web-address', roles: ['owner'] });
  return rowOf(id);
}

export async function addDomainNote(a: AdminActor, id: string, text: string) {
  const { r } = await byId(id);
  await OwnDomainModel.updateOne({ _id: r._id, shopId: r.shopId }, { $push: { notes: { text, byName: a.name, at: new Date() } } });
  return rowOf(id);
}

/** Admin "Check DNS" for one domain. */
export async function adminCheckDns(id: string, now = new Date()) {
  const { r } = await byId(id);
  await saveDns(r, now);
  return rowOf(id);
}
