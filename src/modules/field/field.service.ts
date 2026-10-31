import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { fieldCodeEmail, fieldWelcomeEmail, ownerDraftEmail } from '../../services/email-templates';
import type { Lang } from '../../core/lang';
import { queueMail } from '../../services/mail-queue';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { platform } from '../admin/platform';
import { ReferralModel } from '../referral/referral.model';
import { normCode } from '../referral/referral.service';
import { ShopModel } from '../shops/shop.model';
import { SubscriptionPaymentModel } from '../subscription/billing.model';
import { SubscriptionModel, statusAt } from '../subscription/subscription.model';
import type { FieldActor } from './field-auth';
import { FieldSessionModel, FieldStaffModel, ShopDraftModel, ShopStaffLinkModel } from './field.model';

const DAY = 86_400_000;
const DRAFT_DAYS = 30;
export const CODE_RE = /^[A-Z0-9]{4,12}$/;
const nameOf = (s: { name?: string | null; email: string }) => s.name || s.email.split('@')[0] || s.email;

interface CodeRow {
  code: string;
  trialDays?: number | null;
}
/** Every code a partner has — the main one first — each with its own trial (null → Platform settings). */
const codesOf = (s: { code: string; trialDays?: number | null; moreCodes?: CodeRow[] | null }): { code: string; trialDays: number | null }[] => [
  { code: s.code, trialDays: s.trialDays ?? null },
  ...(s.moreCodes ?? []).map((c) => ({ code: c.code, trialDays: c.trialDays ?? null })),
];

/** An active partner by any of their codes, as typed in the onboarding box (spaces, dashes and case ignored); `code` and `trialDays` are the matched code's. */
export async function staffByCode(code: string, session?: ClientSession) {
  const c = normCode(code);
  if (!c) return null;
  const s = await FieldStaffModel.findOne({ status: 'active', $or: [{ code: c }, { 'moreCodes.code': c }] }).select('name email code trialDays moreCodes').session(session ?? null).lean();
  if (!s) return null;
  const hit = codesOf(s).find((x) => x.code === c);
  return { _id: s._id, name: s.name, email: s.email, code: c, trialDays: hit?.trialDays ?? null };
}

/** "120-day free trial", or "no free trial" for a 0-day code. */
export const trialWords = (days: number) => (days > 0 ? `${String(days)}-day free trial` : 'no free trial');

/** The free trial a code gives: its own (0 = none), else the partner trial in Platform settings. */
const trialOf = (c: { trialDays: number | null }, p: { staffTrialDays: number }) => c.trialDays ?? p.staffTrialDays;

/** Onboarding: what this code gives. */
export async function codeInfo(code: string) {
  const s = await staffByCode(code);
  return s ? { kind: 'staff' as const, code: s.code, staffName: nameOf(s), trialDays: trialOf(s, await platform()) } : null;
}

export async function linkAtSignup(shopId: Types.ObjectId, staff: { _id: Types.ObjectId; code: string }, by: string, onboarded: boolean, session: ClientSession) {
  await ShopStaffLinkModel.create([{ shopId, staffId: staff._id, code: staff.code, source: onboarded ? 'onboarded' : 'signup', by, trialGiven: true }], { session });
}

/**
 * The code came later (the owner forgot it): it counts for the staff member, and while the shop has not paid, its
 * trial runs to the staff trial from signup. One code per shop — a shop referral or a staff code.
 */
export async function applyLater(shopId: Types.ObjectId, code: string, by: string, source: 'admin' | 'owner', reason = '') {
  const staff = await staffByCode(code);
  if (!staff) throw AppError.validation('This code doesn’t work — check it', [{ field: 'body.code', message: 'This code doesn’t work — check it' }]);
  const had = await ShopStaffLinkModel.findOne({ shopId }).lean();
  if (had) throw AppError.conflict(`This shop already has the code ${had.code}`);
  if (await ReferralModel.exists({ refereeShopId: shopId })) throw AppError.conflict('This shop joined with another shop’s referral code — one code per shop');
  const [sub, paid, p] = await Promise.all([SubscriptionModel.findOne({ shopId }).lean(), SubscriptionPaymentModel.exists({ shopId, status: 'paid' }), platform()]);
  if (!sub) throw AppError.notFound('Shop not found');
  const days = trialOf(staff, p);
  const until = new Date(sub.startDate.getTime() + days * DAY);
  const now = new Date();
  const trial = !paid && sub.planCode === 'trial' && sub.status !== 'cancelled' && until > now;
  await ShopStaffLinkModel.create({ shopId, staffId: staff._id, code: staff.code, source, by, trialGiven: trial, reason });
  if (trial && until > sub.endDate) await SubscriptionModel.updateOne({ shopId, planCode: 'trial' }, { $set: { endDate: until, status: 'trial' } });
  return { code: staff.code, staffName: nameOf(staff), trialGiven: trial, trialEnds: trial ? (until > sub.endDate ? until : sub.endDate) : null, why: trial ? '' : paid || sub.planCode !== 'trial' ? 'The shop has already paid — the code counts for the staff member, the trial does not change.' : days > 0 ? `${String(days)} days from signup have passed — the code counts, the trial does not change.` : 'This code gives no free trial — it is saved, the trial does not change.' };
}

/** The staff member's own shops: joined with the code, and the ones waiting for their owner. */
export async function myShops(f: FieldActor, now = new Date()) {
  const staffId = new Types.ObjectId(f.id);
  const [links, drafts, p, me] = await Promise.all([ShopStaffLinkModel.find({ staffId }).sort({ createdAt: -1 }).limit(500).lean(), ShopDraftModel.find({ staffId, status: { $in: ['waiting', 'done'] } }).sort({ createdAt: -1 }).limit(200).lean(), platform(), FieldStaffModel.findById(staffId).select('code trialDays moreCodes').lean()]);
  const codes = codesOf(me ?? { code: f.code }).map((c) => ({ code: c.code, trialDays: trialOf(c, p), link: `${env.SHOP_APP_URL}/login?ref=${c.code}` }));
  const ids = links.map((l) => l.shopId);
  const [shops, subs, paid] = await Promise.all([
    ShopModel.find({ _id: { $in: ids } }).select('name address.city').lean(),
    SubscriptionModel.find({ shopId: { $in: ids } }).select('shopId planCode status endDate').lean(),
    SubscriptionPaymentModel.distinct('shopId', { shopId: { $in: ids }, status: 'paid' }),
  ]);
  const paying = new Set(paid.map(String));
  const month = new Date(now.getTime() - 30 * DAY);
  const rows = links.map((l) => {
    const shop = shops.find((s) => s._id.equals(l.shopId));
    const sub = subs.find((s) => s.shopId.equals(l.shopId));
    const status = sub ? statusAt(sub, now) : 'expired';
    return { shopName: shop?.name ?? '—', city: shop?.address?.city ?? '', code: l.code, joinedAt: l.createdAt, source: l.source, status, paid: paying.has(String(l.shopId)), trialEnds: sub?.planCode === 'trial' ? sub.endDate : null };
  });
  return {
    code: f.code,
    link: `${env.SHOP_APP_URL}/login?ref=${f.code}`,
    trialDays: codes[0]?.trialDays ?? p.staffTrialDays,
    codes,
    totals: { joined: rows.length, last30: rows.filter((r) => r.joinedAt >= month).length, onTrial: rows.filter((r) => r.status === 'trial').length, paying: rows.filter((r) => r.paid).length },
    shops: rows,
    drafts: drafts.map((d) => ({ id: String(d._id), shopName: d.shopName, email: d.email, status: d.status === 'waiting' && d.expiresAt < now ? 'expired' : d.status, at: d.createdAt, expiresAt: d.expiresAt })),
  };
}

export interface DraftInput {
  email: string;
  owner: { name: string; phone: string };
  shop: Record<string, unknown> & { name: string };
}

/** Staff fill a shop for its owner; the owner signs in with this email, checks it and accepts the Terms. */
export async function createDraft(f: FieldActor, input: DraftInput, lang: Lang = 'en') {
  const [p, me] = await Promise.all([platform(), FieldStaffModel.findById(f.id).select('code trialDays').lean()]);
  await ShopDraftModel.updateMany({ email: input.email, status: 'waiting' }, { $set: { status: 'cancelled' } });
  const d = await ShopDraftModel.create({ email: input.email, staffId: new Types.ObjectId(f.id), code: f.code, shopName: input.shop.name, form: { owner: input.owner, shop: input.shop }, expiresAt: new Date(Date.now() + DRAFT_DAYS * DAY) });
  const mail = ownerDraftEmail({ ownerName: input.owner.name, shopName: input.shop.name, staffName: f.name, trialDays: trialOf({ trialDays: me?.trialDays ?? null }, p), link: `${env.SHOP_APP_URL}/login?email=${encodeURIComponent(input.email)}`, days: DRAFT_DAYS }, lang);
  await queueMail({ kind: 'shop_draft', to: input.email, ...mail });
  return { id: String(d._id), shopName: d.shopName, email: d.email, status: 'waiting', at: d.createdAt, expiresAt: d.expiresAt };
}

export async function cancelDraft(f: FieldActor, id: string) {
  const r = await ShopDraftModel.updateOne({ _id: new Types.ObjectId(id), staffId: new Types.ObjectId(f.id), status: 'waiting' }, { $set: { status: 'cancelled' } });
  if (!r.modifiedCount) throw AppError.notFound('Nothing waiting with this id');
}

/** The newest waiting draft for the signed-in owner's email, to fill the onboarding form. */
export async function draftFor(email: string) {
  const d = await ShopDraftModel.findOne({ email: email.toLowerCase(), status: 'waiting', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
  if (!d) return null;
  const s = await FieldStaffModel.findOne({ _id: d.staffId, status: 'active' }).select('name email code').lean();
  return { id: String(d._id), staffName: s ? nameOf(s) : 'MedBox24', code: s ? s.code : '', form: d.form as unknown };
}

export async function finishDraft(email: string, shopId: Types.ObjectId, session: ClientSession) {
  const d = await ShopDraftModel.findOneAndUpdate({ email: email.toLowerCase(), status: 'waiting', expiresAt: { $gt: new Date() } }, { $set: { status: 'done', shopId } }, { sort: { createdAt: -1 }, session, returnDocument: 'after' }).lean();
  return d ? d.staffId : null;
}

// Admin console.

export async function adminList() {
  const [staff, p] = await Promise.all([FieldStaffModel.find({}).sort({ createdAt: -1 }).lean(), platform()]);
  const [counts, paying] = await Promise.all([
    ShopStaffLinkModel.aggregate<{ _id: Types.ObjectId; n: number; shops: Types.ObjectId[] }>([{ $group: { _id: '$staffId', n: { $sum: 1 }, shops: { $push: '$shopId' } } }]),
    SubscriptionPaymentModel.distinct('shopId', { status: 'paid' }),
  ]);
  const paid = new Set(paying.map(String));
  return staff.map((s) => {
    const c = counts.find((x) => x._id.equals(s._id));
    return {
      id: String(s._id), name: nameOf(s), email: s.email, phone: s.phone, code: s.code, status: s.status, hasPassword: Boolean(s.passwordHash), lastLoginAt: s.lastLoginAt ?? null,
      codes: codesOf(s).map((x) => ({ code: x.code, trialDays: x.trialDays, gives: trialOf(x, p) })),
      joined: c?.n ?? 0, paying: c?.shops.filter((x) => paid.has(String(x))).length ?? 0, at: s.createdAt,
    };
  });
}

const codeError = (message: string) => AppError.validation(message, [{ field: 'body.code', message }]);

/** A new code: the right shape, and nobody's yet — no partner (main or extra code) and no shop's referral code. */
async function freeCode(raw: string) {
  const code = normCode(raw);
  if (!CODE_RE.test(code)) throw codeError('A code is 4 to 12 letters or digits, like RAHUL90');
  if (await FieldStaffModel.exists({ $or: [{ code }, { 'moreCodes.code': code }] })) throw codeError('Another partner has this code — pick another');
  if (await ShopModel.exists({ referralCode: code })) throw codeError('A shop’s referral code is the same — pick another');
  return code;
}

/** The admin gives the email and a code (its free trial optional); the partner adds their name inside. */
export async function adminCreate(a: AdminActor, input: { email: string; code: string; trialDays?: number | null }, reason: string, ip?: string) {
  if (await FieldStaffModel.exists({ email: input.email })) throw AppError.conflict('This email is already a partner', { field: 'email' });
  const code = await freeCode(input.code);
  const s = await FieldStaffModel.create({ name: '', email: input.email, code, createdBy: a.name, ...(input.trialDays != null ? { trialDays: input.trialDays } : {}) }).catch((err: unknown) => {
    if ((err as { code?: number }).code === 11000) throw AppError.conflict('This email or code was just taken');
    throw err;
  });
  const p = await platform();
  await queueMail({ kind: 'field_welcome', to: s.email, ...fieldWelcomeEmail({ name: nameOf(s), code, trialDays: trialOf({ trialDays: s.trialDays ?? null }, p), link: `${env.ADMIN_APP_URL}/field` }) });
  await log(a, 'field_staff_add', reason, `added partner ${s.email} with code ${code}${s.trialDays != null ? ` (${trialWords(s.trialDays)})` : ''}`, undefined, undefined, ip);
  return adminList();
}

export async function adminUpdate(a: AdminActor, id: string, input: { action: 'disable' | 'enable' | 'reset-password' }, reason: string, ip?: string) {
  const s = await FieldStaffModel.findById(id);
  if (!s) throw AppError.notFound('Partner not found');
  if (input.action === 'reset-password') s.set({ passwordHash: undefined, failedLogins: 0, lockedUntil: undefined });
  else s.set({ status: input.action === 'disable' ? 'disabled' : 'active' });
  await s.save();
  if (input.action !== 'enable') await FieldSessionModel.updateMany({ staffId: s._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  const what = { disable: 'turned off', enable: 'turned on', 'reset-password': 'cleared the password of' }[input.action];
  await log(a, `field_staff_${input.action}`, reason, `${what} partner ${s.email} (${s.code})`, undefined, undefined, ip);
  return adminList();
}

/**
 * A partner's codes. `code` that is already theirs changes its trial (null → Platform settings); a new one is
 * added with its trial and emailed to them; `remove` takes an extra code off (shops that joined with it stay counted).
 */
export async function adminCodes(a: AdminActor, id: string, input: { code?: string; trialDays?: number | null; remove?: string }, reason: string, ip?: string) {
  const s = await FieldStaffModel.findById(id);
  if (!s) throw AppError.notFound('Partner not found');
  const p = await platform();
  let said = '';
  if (input.remove) {
    const c = normCode(input.remove);
    if (c === s.code) throw codeError('The main code stays — remove another one, or remove the partner');
    if (!s.moreCodes.some((x) => x.code === c)) throw AppError.notFound('This partner has no such code');
    await FieldStaffModel.updateOne({ _id: s._id }, { $pull: { moreCodes: { code: c } } });
    said = `removed code ${c}`;
  } else if (input.code !== undefined) {
    const c = normCode(input.code);
    const days = input.trialDays ?? null;
    if (c === s.code) {
      await FieldStaffModel.updateOne({ _id: s._id }, days != null ? { $set: { trialDays: days } } : { $unset: { trialDays: '' } });
      said = `code ${c}: ${days != null ? trialWords(days) : 'trial from Platform settings'}`;
    } else if (s.moreCodes.some((x) => x.code === c)) {
      await FieldStaffModel.updateOne({ _id: s._id, 'moreCodes.code': c }, days != null ? { $set: { 'moreCodes.$.trialDays': days } } : { $unset: { 'moreCodes.$.trialDays': '' } });
      said = `code ${c}: ${days != null ? trialWords(days) : 'trial from Platform settings'}`;
    } else {
      const code = await freeCode(c);
      await FieldStaffModel.updateOne({ _id: s._id }, { $push: { moreCodes: { code, ...(days != null ? { trialDays: days } : {}) } } });
      await queueMail({ kind: 'field_code', to: s.email, ...fieldCodeEmail({ name: nameOf(s), code, trialDays: trialOf({ trialDays: days }, p), link: `${env.ADMIN_APP_URL}/field` }) });
      said = `added code ${code}${days != null ? ` (${trialWords(days)})` : ''}`;
    }
  }
  if (!said) throw AppError.validation('Nothing to change');
  await log(a, 'field_staff_codes', reason, `partner ${s.email}: ${said}`, undefined, undefined, ip);
  return adminList();
}

/**
 * Removes a partner for good: their sign-in, sessions, codes, shops counted for them and shops waiting for an owner.
 * Shops that joined keep their trial and everything in them; the codes are free to give again.
 */
export async function adminRemove(a: AdminActor, id: string, confirm: string, reason: string, ip?: string) {
  const s = await FieldStaffModel.findById(id).lean();
  if (!s) throw AppError.notFound('Partner not found');
  if (normCode(confirm) !== s.code) throw AppError.validation(`Type ${s.code} to remove this partner`, [{ field: 'body.confirm', message: `Type ${s.code} to remove this partner` }]);
  const [links, drafts] = await Promise.all([ShopStaffLinkModel.deleteMany({ staffId: s._id }), ShopDraftModel.deleteMany({ staffId: s._id })]);
  await Promise.all([FieldSessionModel.deleteMany({ staffId: s._id }), FieldStaffModel.deleteOne({ _id: s._id })]);
  await log(a, 'field_staff_remove', reason, `removed partner ${s.email} for good — codes ${codesOf(s).map((c) => c.code).join(', ')}; ${String(links.deletedCount)} shops no longer counted, ${String(drafts.deletedCount)} filled shops dropped`, undefined, undefined, ip);
  return adminList();
}

/** Admin console: the shop forgot the code at signup; reason and audit like every admin action. */
export async function adminApply(a: AdminActor, shopId: Types.ObjectId, code: string, reason: string, ip?: string) {
  const out = await applyLater(shopId, code, a.name, 'admin', reason);
  const shop = await ShopModel.findById(shopId).select('name').lean();
  await log(a, 'shop_staff_code', reason, `added partner code ${out.code} (${out.staffName})${out.trialGiven ? ' — trial runs longer' : ''}`, shop ? { id: shopId, name: shop.name } : undefined, undefined, ip);
  return out;
}

/** The staff member's own name and phone. */
export async function saveProfile(f: FieldActor, input: { name: string; phone: string }) {
  await FieldStaffModel.updateOne({ _id: new Types.ObjectId(f.id) }, { $set: { name: input.name, phone: input.phone } });
}

/** Admin console: a shop's staff code, if any. */
export async function linkOf(shopId: Types.ObjectId) {
  const l = await ShopStaffLinkModel.findOne({ shopId }).lean();
  if (!l) return null;
  const s = await FieldStaffModel.findById(l.staffId).select('name email').lean();
  return { code: l.code, staffName: s ? nameOf(s) : '—', source: l.source, by: l.by, trialGiven: l.trialGiven, at: l.createdAt };
}
