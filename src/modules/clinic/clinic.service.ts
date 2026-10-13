import { Types, type ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { istIsoDay } from '../../utils/date';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { CustomerModel, DoctorModel } from '../customers/customer.model';
import { can } from '../rbac/permissions';
import type { Actor } from '../user/actor';
import { DayCloseModel } from '../dayclose/dayclose.model';
import { AppointmentModel, DoctorPayoutModel, SittingOffModel } from './clinic.model';
import type { BookInput, CancelVisitInput, ChamberInput, PayoutInput, SittingOffInput } from './clinic.validation';

const DAY = 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;
const oid = (id: string) => new Types.ObjectId(id);
const ACTIVE = { $ne: 'cancelled' as const };

export const today = (now = new Date()) => istIsoDay(now);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clockOf = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** When a token can expect to go in: the sitting's start plus the patients before it. */
const timeOf = (start: string, token: number, minutes: number) => clockOf(minutesOf(start) + (token - 1) * minutes);
/** Has this sitting already ended (IST clock)? */
const over = (d: string, end: string, now: Date) => Date.parse(`${d}T00:00:00Z`) - IST + minutesOf(end) * 60_000 < now.getTime();

type Chamber = { fee: number; freeDays: number; commission: { mode: 'pct' | 'flat'; value: number }; minutes: number; sittings: { day: number; start: string; end: string; max: number }[] };
const NO_CHAMBER: Chamber = { fee: 0, freeDays: 0, commission: { mode: 'pct', value: 0 }, minutes: 10, sittings: [] };
const chamberOf = (d: { chamber?: unknown }): Chamber => (d.chamber as Chamber | undefined) ?? NO_CHAMBER;
export const commissionOf = (fee: number, c: Chamber['commission']) => (c.mode === 'pct' ? Math.round((fee * c.value) / 100) : Math.min(c.value, fee));

type VisitLean = NonNullable<Awaited<ReturnType<typeof findVisit>>>;
const findVisit = (t: TenantContext, id: string, session?: ClientSession) => AppointmentModel.findOne({ shopId: t.shopId, _id: oid(id) }).session(session ?? null).lean();

function shape(a: VisitLean, minutes: number) {
  return {
    id: String(a._id),
    doctorId: String(a.doctorId),
    doctorName: a.doctorName,
    day: a.day,
    start: a.start,
    end: a.end,
    token: a.token,
    time: timeOf(a.start, a.token, minutes),
    patient: { name: a.patient.name, age: a.patient.age ?? null, gender: a.patient.gender },
    phone: a.phone,
    customerId: a.customerId ? String(a.customerId) : null,
    kind: a.kind,
    fee: a.fee,
    commission: a.commission,
    paid: a.paid,
    due: Math.max(0, a.fee - a.paid),
    payments: a.payments.map((p) => ({ amount: p.amount, mode: p.mode, at: p.at, by: p.by })),
    status: a.status,
    note: a.note,
    cancelReason: a.cancelReason ?? null,
    createdByName: a.createdByName,
    createdAt: a.createdAt,
  };
}
export type Visit = ReturnType<typeof shape>;

async function doctorOf(t: TenantContext, id: string, session?: ClientSession) {
  const d = await DoctorModel.findOne({ shopId: t.shopId, _id: oid(id), isActive: true }).session(session ?? null).lean();
  if (!d) throw AppError.notFound('Doctor not found');
  return d;
}

/** The sitting a token goes into: it exists that weekday, the doctor is coming, it isn't over, and there is room. */
async function seat(t: TenantContext, doctor: Awaited<ReturnType<typeof doctorOf>>, d: string, start: string, now: Date, session: ClientSession) {
  const c = chamberOf(doctor);
  const s = c.sittings.find((x) => x.day === weekday(d) && x.start === start);
  if (!s) throw AppError.validation(`${doctor.name} doesn’t sit at ${start} on that day`, [{ field: 'body.start', message: 'Not a sitting of this doctor' }]);
  if (d < today(now)) throw AppError.validation('That day has passed', [{ field: 'body.day', message: 'That day has passed' }]);
  if (daysBetween(today(now), d) > 60) throw AppError.validation('Book at most 60 days ahead', [{ field: 'body.day', message: 'At most 60 days ahead' }]);
  if (over(d, s.end, now)) throw AppError.conflict('This sitting is over');
  if (await SittingOffModel.exists({ shopId: t.shopId, doctorId: doctor._id, day: d, start }).session(session)) throw AppError.conflict(`${doctor.name} is not coming to this sitting`, { reason: 'SITTING_OFF' });
  const taken = await AppointmentModel.countDocuments({ shopId: t.shopId, doctorId: doctor._id, day: d, start, status: ACTIVE }).session(session);
  if (taken >= s.max) throw AppError.conflict(`All ${String(s.max)} tokens of this sitting are booked`, { reason: 'FULL' });
  const last = await AppointmentModel.findOne({ shopId: t.shopId, doctorId: doctor._id, day: d, start }).sort({ token: -1 }).select('token').session(session).lean();
  return { sitting: s, token: (last?.token ?? 0) + 1, minutes: c.minutes };
}

const duplicate = (err: unknown) => (err as { code?: number }).code === 11000;

export async function book(t: TenantContext, actor: Actor, input: BookInput, ip?: string) {
  const { result, replayed } = await once(t.shopId, 'appointment', input.clientRequestId, async (session) => {
    const now = new Date();
    const doctor = await doctorOf(t, input.doctorId, session);
    const { sitting, token, minutes } = await seat(t, doctor, input.day, input.start, now, session);
    let customer: { _id: Types.ObjectId; name: string } | null = input.customerId ? await CustomerModel.findOne({ shopId: t.shopId, _id: oid(input.customerId) }).select('name phone').session(session).lean() : await CustomerModel.findOne({ shopId: t.shopId, phone: input.phone }).select('name phone').session(session).lean();
    if (input.customerId && !customer) throw AppError.notFound('Customer not found');
    // A new phone becomes a customer (the one who booked), when this user may add customers.
    if (!customer && can(t.permissions, 'customers', 'create')) {
      const name = input.bookerName || input.patient.name;
      const [made] = await CustomerModel.create([{ shopId: t.shopId, name, nameLower: name.toLowerCase(), phone: input.phone, dob: null, createdBy: oid(actor.id), createdByName: actor.name }], { session });
      if (!made) throw AppError.internal();
      customer = { _id: made._id, name: made.name };
    }
    const nameLower = input.patient.name.toLowerCase();
    const prev = input.kind === 'followup' ? await AppointmentModel.findOne({ shopId: t.shopId, doctorId: doctor._id, phone: input.phone, 'patient.nameLower': nameLower, status: 'seen' }).sort({ day: -1 }).select('_id').session(session).lean() : null;
    const payments = input.payMode && input.fee ? [{ amount: input.fee, mode: input.payMode, at: now, by: actor.name }] : [];
    const doc = {
      shopId: t.shopId,
      fy: fyOf(now),
      clientRequestId: input.clientRequestId,
      doctorId: doctor._id,
      doctorName: doctor.name,
      day: input.day,
      start: sitting.start,
      end: sitting.end,
      token,
      patient: { name: input.patient.name, nameLower, age: input.patient.age, gender: input.patient.gender },
      phone: input.phone,
      customerId: customer?._id ?? null,
      kind: input.kind,
      followUpOf: prev?._id ?? null,
      fee: input.fee,
      commission: commissionOf(input.fee, chamberOf(doctor).commission),
      paid: payments.length ? input.fee : 0,
      payments,
      note: input.note,
      createdBy: oid(actor.id),
      createdByName: actor.name,
    };
    const made = await AppointmentModel.create([doc], { session }).catch((err: unknown) => {
      throw duplicate(err) ? AppError.conflict('Someone booked this token at the same moment — try again') : err;
    });
    const a = made[0];
    if (!a) throw AppError.internal();
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'customers', entityId: String(a._id), entityName: `${doctor.name} #${String(token)}`, text: `${actor.name} booked ${input.patient.name} with ${doctor.name} · ${input.day} ${sitting.start} · token ${String(token)} · ${input.kind === 'followup' ? 'follow-up' : 'new'} ${inr(input.fee)}${payments.length ? ` paid ${input.payMode ?? ''}` : ' to pay at the visit'}`, ip },
      session,
    );
    return shape((await findVisit(t, String(a._id), session)) as VisitLean, minutes);
  });
  return { visit: result, replayed };
}

async function minutesFor(t: TenantContext, doctorId: Types.ObjectId) {
  const d = await DoctorModel.findOne({ shopId: t.shopId, _id: doctorId }).select('chamber').lean();
  return d ? chamberOf(d).minutes : 10;
}

async function change(t: TenantContext, actor: Actor, id: string, ip: string | undefined, work: (a: VisitLean, now: Date, session: ClientSession) => Promise<{ set: Record<string, unknown>; push?: Record<string, unknown>; pop?: Record<string, 1>; text: string }>) {
  return inTransaction(async (session) => {
    const now = new Date();
    const a = await findVisit(t, id, session);
    if (!a) throw AppError.notFound('Appointment not found');
    const { set, push, pop, text } = await work(a, now, session);
    const done = await AppointmentModel.updateOne({ shopId: t.shopId, _id: a._id, status: a.status, paid: a.paid, day: a.day, start: a.start }, { $set: set, ...(push ? { $push: push } : {}), ...(pop ? { $pop: pop } : {}) }, { session });
    if (!done.modifiedCount) throw AppError.conflict('This appointment changed meanwhile — reload');
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: set.status === 'cancelled' ? 'cancel' : 'update', module: 'customers', entityId: String(a._id), entityName: `${a.doctorName} #${String(a.token)}`, text: `${actor.name} · ${a.patient.name} with ${a.doctorName} ${a.day} ${a.start} · ${text}`, ip }, session);
    return shape((await findVisit(t, id, session)) as VisitLean, await minutesFor(t, a.doctorId));
  });
}

/** The fee still due, paid in one go (cash, UPI or card). */
export function pay(t: TenantContext, actor: Actor, id: string, mode: 'CASH' | 'UPI' | 'CARD', ip?: string) {
  return change(t, actor, id, ip, (a, now) => {
    if (a.status === 'cancelled') throw AppError.conflict('This appointment is cancelled');
    const due = a.fee - a.paid;
    if (due <= 0) throw AppError.conflict('Nothing is due on this appointment');
    return Promise.resolve({ set: { paid: a.fee }, push: { payments: { amount: due, mode, at: now, by: actor.name } }, text: `fee ${inr(due)} paid ${mode}` });
  });
}

export const UNDO_MINUTES = 10;

/** A fee taken by mistake: the last payment comes off within 10 minutes, while its day is still open. */
export function undoPay(t: TenantContext, actor: Actor, id: string, ip?: string) {
  return change(t, actor, id, ip, async (a, now, session) => {
    const last = a.payments.at(-1);
    if (a.status === 'cancelled' || !last || last.amount <= 0) throw AppError.conflict('There is no payment to undo');
    if (now.getTime() - last.at.getTime() > UNDO_MINUTES * 60_000) throw AppError.conflict(`A payment can be undone only within ${String(UNDO_MINUTES)} minutes`);
    if (await DayCloseModel.exists({ shopId: t.shopId, day: today(last.at) }).session(session)) throw AppError.conflict('That day is closed — the payment stays');
    if (a.status === 'seen' || a.status === 'no_show') {
      const owed = (await dues(t)).find((x) => x.id === String(a.doctorId))?.balance ?? 0;
      if (owed < last.amount) throw AppError.conflict('The doctor has been paid this fee already — it can’t be undone');
    }
    return { set: { paid: a.paid - last.amount }, pop: { payments: 1 }, text: `${inr(last.amount)} ${last.mode} undone` };
  });
}

const NEXT: Record<string, readonly string[]> = { booked: ['arrived', 'seen', 'no_show'], arrived: ['seen', 'no_show', 'booked'], seen: ['arrived'], no_show: ['booked', 'arrived'] };
const SAID: Record<string, string> = { booked: 'back to booked', arrived: 'arrived', seen: 'seen by the doctor', no_show: 'did not come' };

export function setStatus(t: TenantContext, actor: Actor, id: string, status: 'booked' | 'arrived' | 'seen' | 'no_show', ip?: string) {
  return change(t, actor, id, ip, (a, now) => {
    if (!(NEXT[a.status] ?? []).includes(status)) throw AppError.conflict(`A ${a.status.replace('_', '-')} appointment can’t be marked ${SAID[status] ?? status}`);
    const at = status === 'arrived' ? { arrivedAt: now } : status === 'seen' ? { seenAt: now } : {};
    return Promise.resolve({ set: { status, ...at }, text: SAID[status] ?? status });
  });
}

/** Cancelled before the visit; a fee already paid goes back the way the patient chooses. */
export function cancel(t: TenantContext, actor: Actor, id: string, input: CancelVisitInput, ip?: string) {
  return change(t, actor, id, ip, (a, now) => {
    if (a.status === 'cancelled') throw AppError.conflict('Already cancelled');
    if (a.status === 'seen') throw AppError.conflict('The doctor has seen this patient — it can’t be cancelled');
    if (a.paid > 0 && !input.refundMode) throw AppError.validation(`${inr(a.paid)} was paid — how is it given back?`, [{ field: 'body.refundMode', message: 'Choose how the fee goes back' }]);
    const refund = a.paid > 0 && input.refundMode ? { amount: -a.paid, mode: input.refundMode, at: now, by: actor.name } : null;
    return Promise.resolve({ set: { status: 'cancelled', paid: 0, cancelReason: input.reason, cancelledBy: actor.name, cancelledAt: now }, ...(refund ? { push: { payments: refund } } : {}), text: `cancelled · ${input.reason}${refund ? ` · ${inr(a.paid)} given back ${input.refundMode ?? ''}` : ''}` });
  });
}

/** Another day or sitting of the same doctor: a new token there; what was paid moves with it. */
export function move(t: TenantContext, actor: Actor, id: string, to: { day: string; start: string }, ip?: string) {
  return change(t, actor, id, ip, async (a, now, session) => {
    if (a.status !== 'booked') throw AppError.conflict('Only a booked appointment can move');
    if (a.day === to.day && a.start === to.start) throw AppError.validation('That is the same sitting', [{ field: 'body.start', message: 'Same sitting' }]);
    const doctor = await doctorOf(t, String(a.doctorId), session);
    const { sitting, token } = await seat(t, doctor, to.day, to.start, now, session);
    return { set: { day: to.day, start: sitting.start, end: sitting.end, token }, text: `moved to ${to.day} ${sitting.start} · token ${String(token)}` };
  });
}

/** Free follow-up or full fee, before anything is paid. */
export function setFee(t: TenantContext, actor: Actor, id: string, input: { kind: 'new' | 'followup'; fee: number }, ip?: string) {
  return change(t, actor, id, ip, async (a, _now, session) => {
    if (a.status === 'cancelled' || a.status === 'seen') throw AppError.conflict(`This appointment is ${a.status}`);
    if (a.paid > 0) throw AppError.conflict('A fee was paid — cancel and book again to change it');
    const doctor = await doctorOf(t, String(a.doctorId), session);
    return { set: { kind: input.kind, fee: input.fee, commission: commissionOf(input.fee, chamberOf(doctor).commission) }, text: `fee ${inr(a.fee)} → ${inr(input.fee)} (${input.kind === 'followup' ? 'follow-up' : 'new'})` };
  });
}

/** The doctor won't come: no new tokens, unpaid ones are cancelled; paid ones stay to be given back or moved. */
export async function sittingOff(t: TenantContext, actor: Actor, input: SittingOffInput, ip?: string) {
  return inTransaction(async (session) => {
    const doctor = await doctorOf(t, input.doctorId, session);
    const now = new Date();
    await SittingOffModel.updateOne({ shopId: t.shopId, doctorId: doctor._id, day: input.day, start: input.start }, { $setOnInsert: { reason: input.reason, by: actor.name } }, { upsert: true, session });
    const open = await AppointmentModel.find({ shopId: t.shopId, doctorId: doctor._id, day: input.day, start: input.start, status: { $in: ['booked', 'arrived'] } }).sort({ token: 1 }).session(session).lean();
    const unpaid = open.filter((a) => a.paid === 0);
    const reason = `Doctor not coming${input.reason ? ` — ${input.reason}` : ''}`;
    if (unpaid.length) await AppointmentModel.updateMany({ shopId: t.shopId, _id: { $in: unpaid.map((a) => a._id) }, paid: 0 }, { $set: { status: 'cancelled', cancelReason: reason, cancelledBy: actor.name, cancelledAt: now } }, { session });
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'cancel', module: 'customers', entityId: String(doctor._id), entityName: doctor.name, text: `${actor.name} marked ${doctor.name} not coming ${input.day} ${input.start}${input.reason ? ` · ${input.reason}` : ''} · ${String(unpaid.length)} cancelled, ${String(open.length - unpaid.length)} paid to give back or move`, ip }, session);
    const tell = (a: (typeof open)[number]) => ({ id: String(a._id), token: a.token, patient: a.patient.name, phone: a.phone, paid: a.paid });
    return { cancelled: unpaid.map(tell), paid: open.filter((a) => a.paid > 0).map(tell) };
  });
}

export async function sittingOn(t: TenantContext, actor: Actor, input: { doctorId: string; day: string; start: string }, ip?: string) {
  const doctor = await doctorOf(t, input.doctorId);
  const done = await SittingOffModel.deleteOne({ shopId: t.shopId, doctorId: doctor._id, day: input.day, start: input.start });
  if (!done.deletedCount) throw AppError.notFound('That sitting was not off');
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'customers', entityId: String(doctor._id), entityName: doctor.name, text: `${actor.name} opened ${doctor.name}’s sitting again · ${input.day} ${input.start}`, ip });
}

/** One day at the shop: every doctor sitting that day, with their tokens. */
export async function dayBoard(t: TenantContext, d: string, now = new Date()) {
  const [doctors, visits, offs] = await Promise.all([
    DoctorModel.find({ shopId: t.shopId, isActive: true }).sort({ nameLower: 1 }).lean(),
    AppointmentModel.find({ shopId: t.shopId, day: d }).sort({ start: 1, token: 1 }).lean(),
    SittingOffModel.find({ shopId: t.shopId, day: d }).lean(),
  ]);
  const wd = weekday(d);
  const rows = doctors.flatMap((doc) => {
    const c = chamberOf(doc);
    const mine = visits.filter((v) => String(v.doctorId) === String(doc._id));
    const starts = [...new Set([...c.sittings.filter((s) => s.day === wd).map((s) => s.start), ...mine.map((v) => v.start)])].sort();
    if (!starts.length) return [];
    const sittings = starts.map((start) => {
      const s = c.sittings.find((x) => x.day === wd && x.start === start);
      const here = mine.filter((v) => v.start === start);
      const end = s?.end ?? here[0]?.end ?? start;
      const active = here.filter((v) => v.status !== 'cancelled');
      return { start, end, max: s?.max ?? active.length, booked: active.length, off: offs.some((o) => String(o.doctorId) === String(doc._id) && o.start === start), over: over(d, end, now), visits: here.map((v) => shape(v, c.minutes)) };
    });
    return [{ id: String(doc._id), name: doc.name, specialization: doc.specialization, fee: c.fee, freeDays: c.freeDays, sittings }];
  });
  return { day: d, today: today(now), doctors: rows };
}

/** The coming sittings of one doctor with room left — what the booking screen offers. */
export async function slots(t: TenantContext, doctorId: string, from: string | undefined, days: number, now = new Date()) {
  const doctor = await doctorOf(t, doctorId);
  const c = chamberOf(doctor);
  const first = from && from > today(now) ? from : today(now);
  const last = addDays(first, days - 1);
  const [counts, offs] = await Promise.all([
    AppointmentModel.aggregate<{ _id: { day: string; start: string }; n: number; top: number }>([{ $match: { shopId: t.shopId, doctorId: doctor._id, day: { $gte: first, $lte: last }, status: ACTIVE } }, { $group: { _id: { day: '$day', start: '$start' }, n: { $sum: 1 }, top: { $max: '$token' } } }]),
    SittingOffModel.find({ shopId: t.shopId, doctorId: doctor._id, day: { $gte: first, $lte: last } }).lean(),
  ]);
  const tops = await AppointmentModel.aggregate<{ _id: { day: string; start: string }; top: number }>([{ $match: { shopId: t.shopId, doctorId: doctor._id, day: { $gte: first, $lte: last } } }, { $group: { _id: { day: '$day', start: '$start' }, top: { $max: '$token' } } }]);
  const out: { day: string; start: string; end: string; max: number; booked: number; left: number; off: boolean; nextToken: number; time: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(first, i);
    for (const s of c.sittings.filter((x) => x.day === weekday(d)).sort((a, b) => a.start.localeCompare(b.start))) {
      if (over(d, s.end, now)) continue;
      const booked = counts.find((x) => x._id.day === d && x._id.start === s.start)?.n ?? 0;
      const nextToken = (tops.find((x) => x._id.day === d && x._id.start === s.start)?.top ?? 0) + 1;
      out.push({ day: d, start: s.start, end: s.end, max: s.max, booked, left: Math.max(0, s.max - booked), off: offs.some((o) => o.day === d && o.start === s.start), nextToken, time: timeOf(s.start, nextToken, c.minutes) });
    }
  }
  return { doctor: { id: String(doctor._id), name: doctor.name, specialization: doctor.specialization, fee: c.fee, freeDays: c.freeDays }, slots: out };
}

/** A phone at the counter: the customer, everyone booked on it before, and who is due a free follow-up. */
export async function lookup(t: TenantContext, phone: string, doctorId?: string, d?: string, now = new Date()) {
  const [customer, past, doctor] = await Promise.all([
    CustomerModel.findOne({ shopId: t.shopId, phone }).select('name gender').lean(),
    AppointmentModel.find({ shopId: t.shopId, phone }).sort({ day: -1, createdAt: -1 }).limit(100).lean(),
    doctorId ? DoctorModel.findOne({ shopId: t.shopId, _id: oid(doctorId) }).lean() : null,
  ]);
  const on = d ?? today(now);
  const c = doctor ? chamberOf(doctor) : null;
  const people = new Map<string, { name: string; age: number | null; gender: string; last: { doctorName: string; day: string } | null; followUp: { lastDay: string; daysAgo: number; free: boolean } | null }>();
  for (const a of past) {
    const key = a.patient.nameLower;
    if (!people.has(key)) people.set(key, { name: a.patient.name, age: a.patient.age ?? null, gender: a.patient.gender, last: a.status === 'cancelled' ? null : { doctorName: a.doctorName, day: a.day }, followUp: null });
    const p = people.get(key);
    if (p && !p.last && a.status !== 'cancelled') p.last = { doctorName: a.doctorName, day: a.day };
    if (p && !p.followUp && doctor && c && String(a.doctorId) === String(doctor._id) && a.status === 'seen' && a.day <= on) {
      const ago = daysBetween(a.day, on);
      p.followUp = { lastDay: a.day, daysAgo: ago, free: c.freeDays > 0 && ago <= c.freeDays };
    }
  }
  if (customer && !people.has(customer.name.toLowerCase())) people.set(customer.name.toLowerCase(), { name: customer.name, age: null, gender: customer.gender, last: null, followUp: null });
  return { customer: customer ? { id: String(customer._id), name: customer.name } : null, patients: [...people.values()] };
}

/** What the shop holds for each doctor: fees of visits that happened, less the shop's commission, less payouts. */
export async function dues(t: TenantContext) {
  const [doctors, done, held, paidOut] = await Promise.all([
    DoctorModel.find({ shopId: t.shopId, isActive: true, chamber: { $exists: true } }).sort({ nameLower: 1 }).lean(),
    AppointmentModel.aggregate<{ _id: Types.ObjectId; fees: number; commission: number; visits: number; unpaid: number }>([
      { $match: { shopId: t.shopId, status: { $in: ['seen', 'no_show'] } } },
      { $group: { _id: '$doctorId', fees: { $sum: '$paid' }, commission: { $sum: { $min: ['$commission', '$paid'] } }, visits: { $sum: { $cond: [{ $eq: ['$status', 'seen'] }, 1, 0] } }, unpaid: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'seen'] }, { $lt: ['$paid', '$fee'] }] }, { $subtract: ['$fee', '$paid'] }, 0] } } } },
    ]),
    AppointmentModel.aggregate<{ _id: Types.ObjectId; held: number }>([{ $match: { shopId: t.shopId, status: { $in: ['booked', 'arrived'] }, paid: { $gt: 0 } } }, { $group: { _id: '$doctorId', held: { $sum: '$paid' } } }]),
    DoctorPayoutModel.aggregate<{ _id: Types.ObjectId; paid: number }>([{ $match: { shopId: t.shopId } }, { $group: { _id: '$doctorId', paid: { $sum: '$amount' } } }]),
  ]);
  const of = <T extends { _id: Types.ObjectId }>(rows: T[], id: Types.ObjectId) => rows.find((r) => String(r._id) === String(id));
  return doctors.map((d) => {
    const x = of(done, d._id);
    const fees = x?.fees ?? 0;
    const commission = x?.commission ?? 0;
    const paid = of(paidOut, d._id)?.paid ?? 0;
    return { id: String(d._id), name: d.name, specialization: d.specialization, visits: x?.visits ?? 0, fees, commission, earned: fees - commission, paidOut: paid, balance: fees - commission - paid, notCollected: x?.unpaid ?? 0, advanceHeld: of(held, d._id)?.held ?? 0 };
  });
}

/** One doctor's account: recent visits that count, and payouts. */
export async function account(t: TenantContext, doctorId: string) {
  const doctor = await doctorOf(t, doctorId);
  const [visits, payouts, all] = await Promise.all([
    AppointmentModel.find({ shopId: t.shopId, doctorId: doctor._id, status: { $in: ['seen', 'no_show'] } }).sort({ day: -1, start: -1, token: -1 }).limit(60).lean(),
    DoctorPayoutModel.find({ shopId: t.shopId, doctorId: doctor._id }).sort({ paidAt: -1 }).limit(60).lean(),
    dues(t),
  ]);
  const c = chamberOf(doctor);
  return {
    summary: all.find((x) => x.id === doctorId) ?? null,
    visits: visits.map((v) => ({ ...shape(v, c.minutes), commission: Math.min(v.commission, v.paid), toDoctor: v.paid - Math.min(v.commission, v.paid) })),
    payouts: payouts.map((p) => ({ id: String(p._id), amount: p.amount, mode: p.mode, fromDrawer: p.fromDrawer, paidAt: p.paidAt, note: p.note, by: p.createdByName })),
  };
}

export async function payout(t: TenantContext, actor: Actor, input: PayoutInput, ip?: string) {
  const { result, replayed } = await once(t.shopId, 'doctor-payout', input.clientRequestId, async (session) => {
    const doctor = await doctorOf(t, input.doctorId, session);
    const due = (await dues(t)).find((x) => x.id === input.doctorId)?.balance ?? 0;
    if (input.amount > due) throw AppError.validation(`Only ${inr(due)} is due to ${doctor.name}`, [{ field: 'body.amount', message: `At most ${inr(due)}` }]);
    const [p] = await DoctorPayoutModel.create([{ shopId: t.shopId, doctorId: doctor._id, doctorName: doctor.name, amount: input.amount, mode: input.mode, fromDrawer: input.mode === 'CASH' && input.fromDrawer, paidAt: new Date(), note: input.note, createdBy: oid(actor.id), createdByName: actor.name }], { session });
    if (!p) throw AppError.internal();
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'customers', entityId: String(doctor._id), entityName: doctor.name, text: `${actor.name} paid ${doctor.name} ${inr(input.amount)} ${input.mode}${input.fromDrawer ? ' from the drawer' : ''}${input.note ? ` · ${input.note}` : ''}`, ip }, session);
    return { id: String(p._id), amount: p.amount, doctorName: doctor.name };
  });
  return { payout: result, replayed };
}

export async function saveChamber(t: TenantContext, actor: Actor, doctorId: string, input: ChamberInput, ip?: string) {
  const doctor = await doctorOf(t, doctorId);
  const before = chamberOf(doctor);
  await DoctorModel.updateOne({ shopId: t.shopId, _id: doctor._id }, { $set: { chamber: input } });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const when = input.sittings.map((s) => `${days[s.day] ?? ''} ${s.start}–${s.end} (${String(s.max)})`).join(', ') || 'no sittings';
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'customers', entityId: String(doctor._id), entityName: doctor.name, text: `${actor.name} set ${doctor.name}’s chamber: fee ${inr(before.fee)} → ${inr(input.fee)}, free follow-up ${String(input.freeDays)} days, shop keeps ${input.commission.mode === 'pct' ? `${String(input.commission.value)}%` : inr(input.commission.value)} · ${when}`, ip });
  return { id: doctorId, chamber: input };
}

/** Day close (PLAN §35.3): fee cash in, refunds and payouts from the drawer out. */
export async function cashOfDay(t: TenantContext, d0: Date, d1: Date) {
  const [visits, payouts] = await Promise.all([
    AppointmentModel.find({ shopId: t.shopId, payments: { $elemMatch: { at: { $gte: d0, $lt: d1 }, mode: 'CASH' } } }).select('payments').lean(),
    DoctorPayoutModel.find({ shopId: t.shopId, paidAt: { $gte: d0, $lt: d1 }, mode: 'CASH', fromDrawer: true }).select('amount').lean(),
  ]);
  let fees = 0;
  let back = 0;
  for (const v of visits) for (const p of v.payments) if (p.mode === 'CASH' && p.at >= d0 && p.at < d1) { if (p.amount > 0) fees += p.amount; else back -= p.amount; }
  return { doctorFees: fees, doctorOut: back + payouts.reduce((s, p) => s + p.amount, 0) };
}
