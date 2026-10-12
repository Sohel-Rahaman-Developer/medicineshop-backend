import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { Types, type Collection } from 'mongoose';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import { contextFor, type TenantContext } from '../../core/middleware/tenant';
import { istDayStart, istIsoDay } from '../../utils/date';
import { fyOf } from '../../utils/fy';
import { AuditLogModel } from '../audit/audit.model';
import { CustomerModel, CustomerPaymentModel, DoctorModel } from '../customers/customer.model';
import * as customers from '../customers/customers.service';
import { addUdhaarSchema, collectSchema, customerSchema, doctorSchema } from '../customers/customers.validation';
import { DayCloseModel } from '../dayclose/dayclose.model';
import * as dayclose from '../dayclose/dayclose.service';
import { AppointmentModel } from '../clinic/clinic.model';
import * as clinic from '../clinic/clinic.service';
import { ExpenseModel } from '../expenses/expense.model';
import * as expenses from '../expenses/expenses.service';
import { expenseSchema } from '../expenses/expenses.validation';
import { LoyaltyModel } from '../loyalty/loyalty.model';
import * as loyalty from '../loyalty/loyalty.service';
import { rulesSchema } from '../loyalty/loyalty.validation';
import { OrderModel } from '../orders/order.model';
import * as orders from '../orders/orders.service';
import { orderSchema } from '../orders/orders.validation';
import { ProductModel } from '../products/product.model';
import { importRows, importSchema } from '../products/products.import';
import { PurchaseModel, SupplierPaymentModel } from '../purchases/purchase.model';
import * as purchases from '../purchases/purchases.service';
import { purchaseSchema } from '../purchases/purchases.validation';
import { SaleReturnModel } from '../sales/sale-return.model';
import * as saleReturns from '../sales/sale-returns.service';
import { SaleModel } from '../sales/sale.model';
import * as sales from '../sales/sales.service';
import { saleReturnSchema, saleSchema } from '../sales/sales.validation';
import { BatchModel } from '../stock/batch.model';
import { MovementModel } from '../stock/movement.model';
import { SupplierModel } from '../suppliers/supplier.model';
import * as suppliers from '../suppliers/suppliers.service';
import { paymentSchema, supplierSchema } from '../suppliers/suppliers.validation';
import { UserModel } from '../user/user.model';
import type { Actor } from '../user/actor';
import { BASKETS, CATALOG, CUSTOMERS, DOCTORS, IMPORT_KEYS, OLD_KHATA, RESTOCK, SHORT_DATED, SUPPLIERS } from './demo.data';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Days of trading behind today: this month and the whole of last month. */
export const HISTORY_DAYS = 60;
// A growing shop: Saturday busiest, Sunday a half day; mornings and evenings are the rush.
const DOW = [0.6, 1, 0.95, 1, 1, 1.1, 1.2];
const HOURS: [hour: number, weight: number][] = [[9, 6], [10, 9], [11, 10], [12, 8], [13, 5], [14, 3], [15, 3], [16, 4], [17, 7], [18, 10], [19, 11], [20, 9], [21, 4]];
const HOUR_SUM = HOURS.reduce((s, [, w]) => s + w, 0);
/** Opening stock covers two months of selling; batches near expiry keep their small counts. */
export const STOCK_SCALE = 3;

type Who = 'owner' | 'manager' | 'cashier' | 'stock';
interface Person { t: TenantContext; actor: Actor }
type Crew = Record<Who, Person>;

type Event =
  | { at: number; kind: 'bill'; basket: number; mode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT'; customer: number | null; who: Who; discount: number }
  | { at: number; kind: 'purchase'; supplier: number; lines: number[]; pay: 'full' | 'part' | 'credit'; seq: number; short?: boolean }
  | { at: number; kind: 'expense'; category: string; description: string; amount: number; mode: 'CASH' | 'UPI' | 'BANK' }
  | { at: number; kind: 'collect'; pick: number }
  | { at: number; kind: 'supplierPay'; supplier: number }
  | { at: number; kind: 'return'; pick: number }
  | { at: number; kind: 'cancel' }
  | { at: number; kind: 'order'; customer: number }
  | { at: number; kind: 'close'; short: boolean };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** One IST day of the shop, the same every time it is asked for: bills, buying, cash and the day close. */
export function dayPlan(dayStart: Date, today: Date): Event[] {
  const n = Math.round((dayStart.getTime() + 5.5 * HOUR) / DAY);
  const r = rng(n * 7919);
  const ist = new Date(dayStart.getTime() + 5.5 * HOUR);
  const dow = ist.getUTCDay();
  const dom = ist.getUTCDate();
  const out: Event[] = [];
  // About 11 bills a day two months back, 24 today, so every chart leans up.
  const ago = Math.min(HISTORY_DAYS, Math.max(0, Math.round((today.getTime() - dayStart.getTime()) / DAY)));
  const bills = Math.round((24 - (13 * ago) / HISTORY_DAYS) * (DOW[dow] ?? 1) * (0.92 + r() * 0.16));
  for (let i = 0; i < bills; i++) {
    let pick = r() * HOUR_SUM;
    const slot = HOURS.find(([, w]) => (pick -= w) < 0) ?? [12, 0];
    const h = slot[0] + r() * 0.95;
    const p = r();
    const mode = p < 0.1 ? 'CREDIT' : p < 0.55 ? 'UPI' : p < 0.62 ? 'CARD' : 'CASH';
    const withCustomer = mode === 'CREDIT' || r() < 0.4;
    const w = r();
    out.push({ at: h * HOUR, kind: 'bill', basket: Math.floor(r() * BASKETS.length), mode, customer: withCustomer ? Math.floor(r() * CUSTOMERS.length) : null, who: w < 0.5 ? 'cashier' : w < 0.8 ? 'manager' : 'owner', discount: r() < 0.08 ? (r() < 0.5 ? 5 : 10) : 0 });
  }
  if (n % 5 === 2) {
    const lines = [...new Set(Array.from({ length: 6 }, () => Math.floor(r() * RESTOCK.length)))];
    out.push({ at: 11.5 * HOUR, kind: 'purchase', supplier: Math.floor(n / 5) % 3, lines, pay: (['full', 'part', 'credit'] as const)[n % 3] ?? 'credit', seq: n });
  }
  if (ago === 10) out.push({ at: 12.4 * HOUR, kind: 'purchase', supplier: 1, lines: SHORT_DATED.map((_, i) => i), pay: 'credit', seq: n + 50_000, short: true });
  if (dom === 1) {
    out.push({ at: 10.25 * HOUR, kind: 'expense', category: 'Rent', description: 'Shop rent', amount: 1_800_000, mode: 'BANK' });
    out.push({ at: 10.3 * HOUR, kind: 'expense', category: 'Salary', description: 'Staff salary — 3 people', amount: 4_200_000, mode: 'BANK' });
  }
  if (dom === 10) out.push({ at: 12.2 * HOUR, kind: 'expense', category: 'Electricity', description: 'CESC bill', amount: 348_000, mode: 'UPI' });
  if (n % 2 === 0) out.push({ at: 16.4 * HOUR, kind: 'expense', category: 'Staff tea', description: 'Tea and biscuits', amount: (12 + Math.floor(r() * 7)) * 1000, mode: 'CASH' });
  if (dow === 6) out.push({ at: 15.1 * HOUR, kind: 'expense', category: 'Delivery', description: 'Home delivery boy', amount: (25 + Math.floor(r() * 15)) * 1000, mode: 'CASH' });
  if (n % 3 === 0) out.push({ at: 18.15 * HOUR, kind: 'collect', pick: r() });
  if (n % 7 === 4) out.push({ at: 12 * HOUR, kind: 'supplierPay', supplier: n % 3 });
  if (n % 5 === 1) out.push({ at: 19.3 * HOUR, kind: 'return', pick: r() });
  if (n % 9 === 3) out.push({ at: 13.05 * HOUR, kind: 'cancel' });
  if (n % 2 === 1 && dayStart.getTime() >= today.getTime() - 3 * DAY) out.push({ at: 17.7 * HOUR, kind: 'order', customer: Math.floor(r() * CUSTOMERS.length) });
  out.push({ at: 21.8 * HOUR, kind: 'close', short: n % 11 === 0 });
  return out.sort((a, b) => a.at - b.at);
}

// Every write lands at the real clock; each step's window of real time is then moved to its place in the story.
const RETIME: { model: { collection: Collection }; key: string; set: string[] }[] = [
  { model: SaleModel, key: 'createdAt', set: ['billDate', 'createdAt', 'updatedAt'] },
  { model: SaleModel, key: 'cancelledAt', set: ['cancelledAt'] },
  { model: MovementModel, key: 'at', set: ['at'] },
  { model: BatchModel, key: 'createdAt', set: ['createdAt'] },
  { model: LoyaltyModel, key: 'createdAt', set: ['createdAt'] },
  { model: AuditLogModel, key: 'createdAt', set: ['createdAt'] },
  { model: CustomerPaymentModel, key: 'createdAt', set: ['paymentDate', 'createdAt', 'updatedAt'] },
  { model: SupplierPaymentModel, key: 'createdAt', set: ['paymentDate', 'createdAt', 'updatedAt'] },
  { model: SaleReturnModel, key: 'createdAt', set: ['returnDate', 'createdAt', 'updatedAt'] },
  { model: PurchaseModel, key: 'createdAt', set: ['receivedDate', 'createdAt', 'updatedAt'] },
  { model: PurchaseModel, key: 'paidAt', set: ['paidAt'] },
  { model: ExpenseModel, key: 'createdAt', set: ['createdAt', 'updatedAt'] },
  { model: OrderModel, key: 'createdAt', set: ['createdAt', 'updatedAt'] },
  { model: DayCloseModel, key: 'createdAt', set: ['at', 'createdAt', 'updatedAt'] },
  { model: ProductModel, key: 'createdAt', set: ['createdAt', 'updatedAt'] },
  { model: CustomerModel, key: 'createdAt', set: ['createdAt', 'updatedAt'] },
  { model: SupplierModel, key: 'createdAt', set: ['createdAt', 'updatedAt'] },
  { model: DoctorModel, key: 'createdAt', set: ['createdAt', 'updatedAt'] },
];

class Clock {
  private windows: { from: Date; to: Date; at: Date }[] = [];
  constructor(private readonly shopId: Types.ObjectId) {}

  /** `must`: the step's error stops the fill; otherwise the step is skipped, as a real counter would. */
  async step<T>(at: Date, fn: () => Promise<T>, must = false): Promise<T | null> {
    const from = new Date();
    try {
      return await fn();
    } catch (err) {
      if (must) throw err;
      logger.debug({ err, at }, 'Demo step skipped');
      return null;
    } finally {
      const to = new Date();
      this.windows.push({ from, to, at });
      // The next step starts on a later millisecond, so no write sits in two windows.
      while (Date.now() <= to.getTime()) await tick();
    }
  }

  async flush() {
    if (!this.windows.length) return;
    const w = this.windows;
    this.windows = [];
    for (const { model, key, set } of RETIME) {
      await model.collection.bulkWrite(
        w.map((x) => ({ updateMany: { filter: { shopId: this.shopId, [key]: { $gte: x.from, $lte: x.to } }, update: { $set: Object.fromEntries(set.map((f) => [f, x.at])) } } })),
        { ordered: false },
      );
    }
    // A supplier payment adds to invoices made earlier; each line keeps its own date.
    for (const x of w) {
      await PurchaseModel.collection.updateMany(
        { shopId: this.shopId, 'allocations.at': { $gte: x.from, $lte: x.to } },
        { $set: { 'allocations.$[a].at': x.at } },
        { arrayFilters: [{ 'a.at': { $gte: x.from, $lte: x.to } }] },
      );
    }
  }
}

const expiryIn = (months: number, now: Date) => {
  const d = new Date(now.getTime() + 5.5 * HOUR);
  const m = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(m / 12);
  return { mmyy: `${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}/${String(y).slice(2)}`, ym: `${String(y)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}` };
};

async function crewOf(shopId: Types.ObjectId, emails: Record<Who, string>): Promise<Crew> {
  const out = {} as Crew;
  for (const [who, email] of Object.entries(emails) as [Who, string][]) {
    const u = await UserModel.findOne({ email }).select('name email').lean();
    if (!u) throw AppError.internal(`Demo user ${email} is missing`);
    out[who] = { t: (await contextFor(shopId, u._id)).ctx, actor: { id: String(u._id), name: u.name, email: u.email } };
  }
  return out;
}

/** Products, suppliers, customers and doctors, the day the shop starts on MedBox24. */
export async function setUp(shopId: Types.ObjectId, emails: Record<Who, string>, start: Date) {
  const crew = await crewOf(shopId, emails);
  const { t, actor } = crew.owner;
  const clock = new Clock(shopId);
  const rules = Object.fromEntries(Object.entries(await loyalty.getRules(t)).filter(([k]) => k !== 'configured'));
  await clock.step(start, () => loyalty.updateRules(t, actor, rulesSchema.parse({ ...rules, enabled: true })));
  const rows = CATALOG.map(([name, company, salt, strength, category, schedule, gst, hsn, saleUnit, baseUnit, pack, purchasePack, storage, months, qty, mrp, rate, rack, batch]) => {
    const v: Record<string, string | number> = { name, company, salt, strength, category, schedule, gst, hsn, barcode: '', saleUnit, baseUnit, pack, purchaseUnit: 'BOX', purchasePack, storage, hasExpiry: months === null ? 'No' : 'Yes', batch, expiry: months === null ? '' : expiryIn(months, start).mmyy, quantity: months === null || months > 3 ? qty * STOCK_SCALE : qty, mrp, rate, minPrice: '', rack };
    return Object.fromEntries(IMPORT_KEYS.map((k) => [k, v[k] ?? '']));
  });
  await clock.step(start, () => importRows(t, actor, importSchema.parse({ clientRequestId: randomUUID(), dryRun: false, rows })), true);
  for (const s of SUPPLIERS) await clock.step(start, () => suppliers.create(t, actor, supplierSchema.parse({ ...s, address: 'Bagri Market, Kolkata' })));
  for (const d of DOCTORS) await clock.step(start, () => customers.addDoctor(t, actor, doctorSchema.parse(d)));
  for (const [name, phone, creditLimit] of CUSTOMERS) await clock.step(start, () => customers.create(t, actor, customerSchema.parse({ name, phone, creditLimit })));
  // The khata the shop kept before MedBox24: what three regulars already owed.
  const made = await CustomerModel.find({ shopId }).select('name').lean();
  for (const [name, amount, daysBefore] of OLD_KHATA) {
    const c = made.find((x) => x.name === name);
    if (c) await clock.step(start, () => customers.addUdhaar(t, actor, addUdhaarSchema.parse({ clientRequestId: randomUUID(), customerId: String(c._id), amount, since: istIsoDay(new Date(start.getTime() - daysBefore * DAY)), note: 'Old khata' })));
  }
  await clock.flush();
}

async function lookups(shopId: Types.ObjectId) {
  const [products, custs, sups, docs] = await Promise.all([
    ProductModel.find({ shopId }).select('name units gstRate').lean(),
    CustomerModel.find({ shopId }).select('name phone creditLimit').sort({ _id: 1 }).lean(),
    SupplierModel.find({ shopId }).select('name').sort({ _id: 1 }).lean(),
    DoctorModel.find({ shopId }).select('name').sort({ _id: 1 }).lean(),
  ]);
  const pid = (prefix: string) => products.find((p) => p.name.startsWith(prefix))?._id;
  return { pid, custs, sups, docs };
}

/** Plays the shop's days from `from` (not included) to `to`; `onEvent` reports progress. */
export async function play(shopId: Types.ObjectId, emails: Record<Who, string>, from: Date, to: Date, onEvent?: (done: number, total: number) => Promise<void>) {
  const crew = await crewOf(shopId, emails);
  const owner = crew.owner;
  const { pid, custs, sups, docs } = await lookups(shopId);
  const clock = new Clock(shopId);
  const today = istDayStart(to);
  const days: { start: Date; events: Event[] }[] = [];
  for (let d = istDayStart(from); d <= today; d = new Date(d.getTime() + DAY)) {
    const events = dayPlan(d, today).filter((e) => d.getTime() + e.at > from.getTime() && d.getTime() + e.at <= to.getTime());
    if (events.length) days.push({ start: d, events });
  }
  const total = days.reduce((s, d) => s + d.events.length, 0);
  let done = 0;
  let skipped = 0;

  const bill = async (e: Extract<Event, { kind: 'bill' }>, at: Date) => {
    const basket = BASKETS[e.basket] ?? [];
    const items = basket.map(([name, quantity, unit]) => ({ productId: String(pid(name) ?? ''), quantity, unit }));
    if (items.some((i) => !i.productId)) return null;
    const h1 = basket.some(([name]) => name === 'Alprax');
    const c = e.customer === null ? undefined : custs[e.customer % custs.length];
    const mode = e.mode === 'CREDIT' && !c?.creditLimit ? 'UPI' : e.mode;
    const who = mode === 'CREDIT' || e.discount ? owner : crew[e.who];
    const base = {
      items,
      ...(c ? { customerId: String(c._id) } : {}),
      ...(h1 ? { rx: { doctorId: String(docs[2]?._id ?? docs[0]?._id), patientName: c?.name ?? 'Amit Das', rxNumber: `RX-${String(at.getTime()).slice(-4)}` } } : {}),
      ...(e.discount ? { billDiscount: { type: 'pct', value: e.discount } } : {}),
    };
    let total = 0;
    try {
      await sales.create(who.t, who.actor, saleSchema.parse({ ...base, clientRequestId: randomUUID(), payments: [], expectedTotal: 0 }));
    } catch (err) {
      total = ((err as AppError).details as { total?: number } | undefined)?.total ?? 0;
      if (!total) throw err;
    }
    const pay = (m: string) => saleSchema.parse({ ...base, clientRequestId: randomUUID(), payments: [{ mode: m, amount: total, reference: m === 'UPI' ? `UPI${String(at.getTime()).slice(-6)}` : '' }] });
    // Over the udhaar limit: the customer pays by UPI instead, as at a real counter.
    return sales.create(who.t, who.actor, pay(mode)).catch(() => (mode === 'CREDIT' ? sales.create(who.t, who.actor, pay('UPI')) : null));
  };

  const run = async (e: Event, at: Date): Promise<unknown> => {
    const { t, actor } = owner;
    switch (e.kind) {
      case 'bill':
        return bill(e, at);
      case 'purchase': {
        const s = sups[e.supplier % sups.length];
        if (!s) return null;
        const lines = e.lines.flatMap((i) => {
          const item = (e.short ? SHORT_DATED : RESTOCK)[i];
          if (!item) return [];
          const [prefix, qty, months] = item;
          const row = CATALOG.find((x) => x[0].startsWith(prefix));
          const productId = pid(prefix);
          if (!row || !productId) return [];
          const [gst, saleUnit, mrp, rate] = [row[6], row[8], row[15], row[16]];
          return [{ productId: String(productId), batchNumber: `${prefix.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()}${String(e.seq).slice(-4)}`, expiry: expiryIn(months, e.short ? today : at).ym, quantity: qty, freeQuantity: qty >= 100 ? 10 : 0, unit: saleUnit, rate: Math.round(rate * 100), mrp: Math.round(mrp * 100), gstRate: gst }];
        });
        if (!lines.length) return null;
        const { result: p } = await purchases.create(t, actor, purchaseSchema.parse({ clientRequestId: randomUUID(), supplierId: String(s._id), invoiceNumber: `${s.name.split(' ').map((w) => w[0]).join('')}/${String(e.seq).slice(-4)}`, invoiceDate: istIsoDay(at), lines }));
        if (e.pay === 'credit') return p;
        const amount = e.pay === 'full' ? p.grandTotal : Math.round(p.grandTotal / 200) * 100;
        return amount ? suppliers.pay(t, actor, String(s._id), paymentSchema.parse({ clientRequestId: randomUUID(), amount, mode: 'NEFT', reference: `NEFT${String(e.seq)}` })) : p;
      }
      case 'expense':
        return expenses.create(t, actor, expenseSchema.parse({ clientRequestId: randomUUID(), date: istIsoDay(at), category: e.category, description: e.description, amount: e.amount, paymentMode: e.mode, fromDrawer: e.mode === 'CASH' }));
      case 'collect': {
        const due = await CustomerModel.find({ shopId, creditBalance: { $gt: 0 } }).select('creditBalance').sort({ _id: 1 }).lean();
        const c = due[Math.floor(e.pick * due.length)];
        if (!c) return null;
        const amount = Math.max(100, Math.round((c.creditBalance * 0.6) / 1000) * 1000);
        return customers.collect(t, actor, String(c._id), collectSchema.parse({ clientRequestId: randomUUID(), amount: Math.min(amount, c.creditBalance), mode: e.pick < 0.5 ? 'UPI' : 'CASH' }));
      }
      case 'supplierPay': {
        const s = sups[e.supplier % sups.length];
        const open = s ? await PurchaseModel.find({ shopId, supplierId: s._id, status: 'active', dueAmount: { $gt: 0 } }).select('dueAmount').lean() : [];
        const due = open.reduce((sum, x) => sum + x.dueAmount, 0);
        if (!s || !due) return null;
        return suppliers.pay(t, actor, String(s._id), paymentSchema.parse({ clientRequestId: randomUUID(), amount: Math.min(due, Math.round(due / 200) * 100 || due), mode: 'UPI', reference: 'UTR' + String(at.getTime()).slice(-6) }));
      }
      case 'return': {
        const recent = await SaleModel.find({ shopId, status: 'completed', billDate: { $gte: new Date(at.getTime() - 4 * DAY), $lt: istDayStart(at) } }).select('lines.quantityInBase lines.salePack').sort({ _id: 1 }).lean();
        const s = recent[Math.floor(e.pick * recent.length)];
        const line = s?.lines[0];
        if (!s || !line) return null;
        return saleReturns.create(t, actor, saleReturnSchema.parse({ clientRequestId: randomUUID(), saleId: String(s._id), items: [{ line: 0, quantity: Math.min(line.quantityInBase, line.salePack), reason: 'Doctor changed the medicine' }], refundMode: 'CASH' }));
      }
      case 'cancel': {
        const last = await SaleModel.findOne({ shopId, status: 'completed', 'payments.mode': { $ne: 'CREDIT' } }).sort({ _id: -1 }).select('_id').lean();
        return last ? sales.cancel(t, actor, String(last._id), 'Customer changed mind') : null;
      }
      case 'order': {
        const c = custs[e.customer % custs.length];
        if (!c) return null;
        return orders.create(t, actor, orderSchema.parse({ clientRequestId: randomUUID(), customer: { name: c.name, phone: c.phone }, items: [{ productId: String(pid('Huminsulin') ?? pid('Dolo 650')), qty: 2 }, { name: 'Nurokind Gold Capsule', qty: 1 }], advance: 20_000, advanceMode: 'CASH', note: 'Call after 5 pm' }));
      }
      case 'close': {
        const day = istIsoDay(at);
        const cash = await dayclose.cashDay(t, day);
        const counted = Math.max(0, cash.expected - (e.short ? 2000 : 0));
        return dayclose.close(t, actor, dayclose.closeSchema.parse({ day, counted, takenOut: Math.max(0, counted - 200_000), note: e.short ? 'Gave ₹20 extra change by mistake' : '' }));
      }
    }
  };

  for (const d of days) {
    for (const e of d.events) {
      const at = new Date(d.start.getTime() + e.at);
      // The close counts the day's cash, so the day's writes must already sit on their own times.
      if (e.kind === 'close') await clock.flush();
      const out = await clock.step(at, () => run(e, at));
      if (out === null) skipped++;
      done++;
      if (onEvent && done % 10 === 0) await onEvent(done, total);
    }
    await clock.flush();
  }
  await settle(shopId);
  await clinicDays(shopId, owner, custs, docs, to);
  return { total, skipped };
}

// D90: three doctors' days and fees, a week of seen patients (paid by UPI, so closed days keep their cash), and tokens for the next sitting.
const CHAMBERS: Record<string, { fee: number; freeDays: number; commission: { mode: 'pct' | 'flat'; value: number }; minutes: number; days: number[]; start: string; end: string; max: number }> = {
  'Dr. S. Banerjee': { fee: 50_000, freeDays: 7, commission: { mode: 'pct', value: 20 }, minutes: 10, days: [0, 1, 2, 3, 4, 5, 6], start: '19:00', end: '21:00', max: 15 },
  'Dr. A. Mukherjee': { fee: 40_000, freeDays: 10, commission: { mode: 'flat', value: 5_000 }, minutes: 12, days: [1, 3, 5], start: '10:00', end: '12:00', max: 12 },
  'Dr. R. Khan': { fee: 80_000, freeDays: 15, commission: { mode: 'pct', value: 25 }, minutes: 20, days: [2, 4, 6], start: '18:00', end: '20:00', max: 8 },
};

async function clinicDays(shopId: Types.ObjectId, owner: Crew['owner'], custs: { _id: Types.ObjectId; name: string; phone: string }[], docs: { _id: Types.ObjectId; name: string }[], now: Date) {
  if (await AppointmentModel.exists({ shopId })) return;
  const { t, actor } = owner;
  for (const d of docs) {
    const c = CHAMBERS[d.name];
    if (c) await clinic.saveChamber(t, actor, String(d._id), { fee: c.fee, freeDays: c.freeDays, commission: c.commission, minutes: c.minutes, sittings: c.days.map((day) => ({ day, start: c.start, end: c.end, max: c.max })) });
  }
  const dr = docs.find((d) => d.name === 'Dr. S. Banerjee');
  const c = CHAMBERS['Dr. S. Banerjee'];
  if (!dr || !c || custs.length < 6) return;
  const today = istIsoDay(now);
  const past: Record<string, unknown>[] = [];
  for (let back = 6; back >= 1; back--) {
    const day = istIsoDay(new Date(now.getTime() - back * DAY));
    for (let i = 0; i < 3; i++) {
      const who = custs[(back * 3 + i) % custs.length];
      if (!who) continue;
      const at = new Date(Date.parse(`${day}T19:00:00+05:30`) + i * 10 * 60_000);
      past.push({ shopId, fy: fyOf(at), clientRequestId: randomUUID(), doctorId: dr._id, doctorName: dr.name, day, start: c.start, end: c.end, token: i + 1, patient: { name: who.name, nameLower: who.name.toLowerCase(), age: 30 + ((back + i) % 40), gender: i % 2 ? 'female' : 'male' }, phone: who.phone, customerId: who._id, kind: 'new', fee: c.fee, commission: clinic.commissionOf(c.fee, c.commission), paid: c.fee, payments: [{ amount: c.fee, mode: 'UPI', at, by: actor.name }], status: 'seen', seenAt: at, createdBy: new Types.ObjectId(actor.id), createdByName: actor.name, createdAt: at, updatedAt: at });
    }
  }
  await AppointmentModel.insertMany(past);
  // The next sitting: today if it isn't over, else tomorrow.
  const day = Date.parse(`${today}T${c.end}:00+05:30`) > now.getTime() ? today : istIsoDay(new Date(now.getTime() + DAY));
  const seenBefore = custs[(3 * 3) % custs.length];
  const book = (who: { _id: Types.ObjectId; phone: string }, patient: { name: string; age: number; gender: 'female' | 'male' }, kind: 'new' | 'followup', payMode?: 'CASH' | 'UPI') =>
    clinic.book(t, actor, { clientRequestId: randomUUID(), doctorId: String(dr._id), day, start: c.start, phone: who.phone, customerId: String(who._id), bookerName: '', patient, kind, fee: kind === 'followup' ? 0 : c.fee, ...(payMode ? { payMode } : {}), note: '' });
  const [a, b, d] = [custs[0], custs[1], custs[2]];
  if (a) await book(a, { name: a.name, age: 52, gender: 'male' }, 'new', 'UPI');
  if (seenBefore) await book(seenBefore, { name: seenBefore.name, age: 41, gender: 'male' }, 'followup');
  if (b) await book(b, { name: 'Riya', age: 9, gender: 'female' }, 'new');
  if (d) await book(d, { name: d.name, age: 63, gender: 'female' }, 'new', 'UPI');
}

/** First and last visit, and when each supplier last sent stock, from the retimed bills. */
async function settle(shopId: Types.ObjectId) {
  const visits = await SaleModel.aggregate<{ _id: Types.ObjectId; first: Date; last: Date }>([
    { $match: { shopId, customerId: { $ne: null }, status: { $ne: 'cancelled' } } },
    { $group: { _id: '$customerId', first: { $min: '$billDate' }, last: { $max: '$billDate' } } },
  ]);
  if (visits.length) await CustomerModel.collection.bulkWrite(visits.map((v) => ({ updateOne: { filter: { shopId, _id: v._id }, update: { $set: { firstVisit: v.first, lastVisit: v.last } } } })));
  const bought = await PurchaseModel.aggregate<{ _id: Types.ObjectId; last: Date }>([{ $match: { shopId, status: 'active' } }, { $group: { _id: '$supplierId', last: { $max: '$receivedDate' } } }]);
  if (bought.length) await SupplierModel.collection.bulkWrite(bought.map((b) => ({ updateOne: { filter: { shopId, _id: b._id }, update: { $set: { lastPurchaseAt: b.last } } } })));
}
