import { Types, type ClientSession } from 'mongoose';
import { afterCursor, page } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { once } from '../../core/idempotency';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { fyOf } from '../../utils/fy';
import { inr } from '../../utils/money';
import { conv, salePack, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import * as customers from '../customers/customers.service';
import * as loyalty from '../loyalty/loyalty.service';
import { emit } from '../notifications/notifications.service';
import * as orders from '../orders/orders.service';
import { CategoryModel } from '../categories/category.model';
import { nextNumber } from '../counters/counter.model';
import { ProductModel } from '../products/product.model';
import { seesCost } from '../products/products.service';
import { can } from '../rbac/permissions';
import { ShopModel } from '../shops/shop.model';
import { BatchModel } from '../stock/batch.model';
import { allocate, daysLeftOut, fefo, hasExpiry, type BatchLike } from '../stock/stock.domain';
import { applyMove, refreshRollups } from '../stock/stock.ledger';
import type { Actor } from '../user/actor';
import { floorOf, priceSale, splitLine, type Part } from './sale.domain';
import { SaleReturnModel } from './sale-return.model';
import { ageDays } from './sale-returns.service';
import { SaleModel } from './sale.model';
import type { SaleInput, SaleListQuery } from './sales.validation';

const DAY = 24 * 60 * 60 * 1000;
const oid = (id: string) => new Types.ObjectId(id);
const itemError = (i: number, message: string) => AppError.validation(message, [{ field: `body.items.${String(i)}`, message }]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type SaleBatch = BatchLike & { _id: Types.ObjectId; productId: Types.ObjectId; batchNumber: string; rack: string; minPrice?: number | null };

/** Cashier and the like see only their own bills (record scope, PLAN §7). */
const ownOnly = (t: TenantContext) => t.scopes.sales === 'own';

/** POS search (PLAN §14): sellable first, out-of-stock after with a flag; an exact barcode is marked so a scan adds it. */
export async function posSearch(t: TenantContext, q: string, limit: number, ids?: string[]) {
  const now = new Date();
  const cost = seesCost(t);
  const filter: Record<string, unknown> = { shopId: t.shopId, isActive: true };
  const tokens = norm(q).split(' ').filter(Boolean).slice(0, 6);
  let exactId: string | null = null;
  if (/^[A-Za-z0-9-]{4,32}$/.test(q)) {
    const hit = await ProductModel.findOne({ shopId: t.shopId, isActive: true, barcode: q }).select('_id').lean();
    if (hit) exactId = String(hit._id);
  }
  if (ids?.length) filter._id = { $in: ids.map(oid) };
  else if (exactId) filter._id = oid(exactId);
  else if (tokens.length) filter.$and = tokens.map((w) => ({ searchKey: { $regex: `(^| )${escape(w)}` } }));
  else filter['stock.sellable'] = { $gt: 0 };
  const rows = await ProductModel.find(filter)
    .sort(tokens.length || exactId ? { 'stock.sellable': -1, nameLower: 1 } : { lastSoldAt: -1, nameLower: 1 })
    .limit(limit)
    .select('name company salt strength scheduleType gstRate hsnCode units defaultRack storageType noExpiry photo.bytes stock.sellable categoryId')
    .lean();
  const batches = await BatchModel.find({ shopId: t.shopId, productId: { $in: rows.map((p) => p._id) }, status: 'active', quantity: { $gt: 0 }, expiryDate: { $gte: now } })
    .select('productId batchNumber expiryDate receivedAt quantity status mrp minPrice rack costPerBaseUnit')
    .lean<SaleBatch[]>();
  const byProduct = new Map<string, SaleBatch[]>();
  for (const b of batches) byProduct.set(String(b.productId), [...(byProduct.get(String(b.productId)) ?? []), b]);
  const cats = new Map((await CategoryModel.find({ shopId: t.shopId }).select('name').lean()).map((c) => [String(c._id), c.name]));
  const items = rows.map((p) => {
    const u = p.units as Units;
    const list = fefo(byProduct.get(String(p._id)) ?? [], now);
    return {
      id: String(p._id),
      name: p.name,
      company: p.company,
      salt: [p.salt, p.strength].filter(Boolean).join(' '),
      category: cats.get(String(p.categoryId)) ?? '',
      scheduleType: p.scheduleType,
      gstRate: p.gstRate,
      units: { base: u.base, sale: u.sale, salePack: salePack(u), allowLooseSale: u.allowLooseSale },
      rack: list[0]?.rack || p.defaultRack,
      cold: p.storageType === 'COLD',
      hasPhoto: Boolean(p.photo?.bytes),
      sellable: list.reduce((s, b) => s + b.quantity, 0),
      batches: list.map((b) => ({
        id: String(b._id),
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate,
        daysLeft: daysLeftOut(b.expiryDate, now),
        quantity: b.quantity,
        mrp: b.mrp,
        minPrice: b.minPrice ?? null,
        rack: b.rack,
        ...(cost ? { costPerBaseUnit: b.costPerBaseUnit } : {}),
      })),
    };
  });
  items.sort((a, b) => Number(b.sellable > 0) - Number(a.sellable > 0));
  return { items, exact: exactId };
}

/** What the counter needs to price a cart the way the server will (no settings: view needed). */
export async function posSettings(t: TenantContext) {
  const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings.billing settings.inventory settings.loyalty').lean();
  const billing = shop?.settings.billing;
  const inv = shop?.settings.inventory;
  const r = loyalty.rulesOf(shop?.settings.loyalty);
  return {
    roundOff: billing?.roundOffEnabled ?? true,
    maxDiscountPercent: billing?.maxDiscountPercent ?? 20,
    enforceH1: billing?.enforceH1Prescription ?? true,
    canPickBatch: (inv?.allowBatchOverride ?? true) && can(t.permissions, 'stock', 'edit'),
    seesCost: seesCost(t),
    loyalty: { ...r, canRedeem: can(t.permissions, 'loyalty', 'create'), canSetUp: can(t.permissions, 'loyalty', 'edit') },
  };
}

interface Built {
  parts: (Part & { item: number; p: ProductLean; b: SaleBatch })[];
  picked: Set<number>;
}
type ProductLean = { _id: Types.ObjectId; name: string; categoryId: Types.ObjectId; hsnCode: string; scheduleType: string; gstRate: number; units: unknown; isActive: boolean };

/** Cart items → FEFO parts with the server's own stock; the same batch is never promised twice in one bill. */
async function buildParts(t: TenantContext, input: SaleInput, now: Date, session: ClientSession): Promise<Built> {
  const ids = [...new Set(input.items.map((i) => i.productId))].map(oid);
  const products = await ProductModel.find({ shopId: t.shopId, _id: { $in: ids } }).select('name categoryId hsnCode scheduleType gstRate units isActive').session(session).lean<ProductLean[]>();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const batches = await BatchModel.find({ shopId: t.shopId, productId: { $in: ids }, status: 'active', quantity: { $gt: 0 } })
    .select('productId batchNumber expiryDate receivedAt quantity status mrp minPrice rack costPerBaseUnit')
    .session(session)
    .lean<SaleBatch[]>();
  const used = new Map<string, number>();
  const out: Built = { parts: [], picked: new Set() };
  for (const [i, it] of input.items.entries()) {
    const p = byId.get(it.productId);
    if (!p) throw itemError(i, `Item ${String(i + 1)}: product not found`);
    if (!p.isActive) throw itemError(i, `${p.name} is deactivated`);
    const u = p.units as Units;
    const loose = it.unit === u.base && u.base !== u.sale;
    if (it.unit !== u.sale && !(loose && u.allowLooseSale)) throw itemError(i, `${p.name} sells by ${u.sale.toLowerCase()}${u.allowLooseSale && u.base !== u.sale ? ` or ${u.base.toLowerCase()}` : ''}`);
    const qtyBase = it.quantity * conv(u, it.unit);
    const left = batches.filter((b) => b.productId.equals(p._id)).map((b) => ({ ...b, quantity: b.quantity - (used.get(String(b._id)) ?? 0) }));
    if (it.batchId) {
      const pin = left.find((b) => String(b._id) === it.batchId);
      if (!pin || !fefo([pin], now).length) throw itemError(i, `${p.name}: that batch can’t be sold — it is expired, blocked or empty`);
      if (String(fefo(left, now)[0]?._id) !== it.batchId) out.picked.add(i);
    }
    const al = allocate(left, qtyBase, now, it.batchId);
    if (al.short > 0) {
      const have = qtyBase - al.short;
      throw AppError.conflict(`Only ${String(have)} ${u.base.toLowerCase()} of ${p.name} left to sell`, { reason: 'SHORT', index: i, available: have });
    }
    const pack = salePack(u);
    const split = splitLine(al.parts.map((x) => ({ mrp: x.batch.mrp, qtyBase: x.qty })), pack, it.price ?? null, it.discount ?? null);
    al.parts.forEach((x, j) => {
      used.set(String(x.batch._id), (used.get(String(x.batch._id)) ?? 0) + x.qty);
      const s = split[j];
      out.parts.push({ item: i, p, b: x.batch, mrp: x.batch.mrp, qtyBase: x.qty, salePack: pack, gstRate: p.gstRate, sell: s?.sell ?? null, discount: s?.discount ?? null });
    });
  }
  return out;
}

export async function create(t: TenantContext, actor: Actor, input: SaleInput, ip?: string) {
  return once(t.shopId, 'sale', input.clientRequestId, async (session) => {
    const now = new Date();
    const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings').session(session).lean();
    if (!shop) throw AppError.notFound('Shop not found');
    const billing = shop.settings.billing;
    const inv = shop.settings.inventory;
    if (!billing || !inv) throw AppError.internal('Shop settings are missing');

    const order = input.orderId ? await orders.forBill(t, input.orderId, session) : null;
    const built = await buildParts(t, input, now, session);
    if (built.picked.size && !(inv.allowBatchOverride && can(t.permissions, 'stock', 'edit'))) {
      throw AppError.forbidden('Choosing a batch by hand needs stock edit permission — FEFO picks the batch.');
    }
    const rxNeeded = built.parts.some((x) => x.p.scheduleType === 'H1' || x.p.scheduleType === 'X');
    // A doctor from the shop's list wins over a typed name (PLAN §14).
    const doctor = input.rx?.doctorId ? await customers.doctorFor(t, input.rx.doctorId, session) : null;
    const doctorName = doctor?.name ?? input.rx?.doctorName ?? '';
    if (rxNeeded && billing.enforceH1Prescription && (!doctorName || !input.rx?.patientName)) {
      throw AppError.validation('Schedule H1 / X: doctor and patient name are required', [{ field: 'body.rx', message: 'Doctor and patient name are required' }]);
    }

    const priced = priceSale(built.parts, input.billDiscount ?? null, { roundOff: billing.roundOffEnabled, igst: false });
    if (input.expectedTotal !== undefined && input.expectedTotal !== priced.grandTotal) {
      throw AppError.conflict(`The total is now ${inr(priced.grandTotal)} — stock or prices changed. Check the bill and charge again.`, { reason: 'TOTAL_CHANGED', total: priced.grandTotal });
    }
    // Udhaar: a customer with room under the limit; the bill's due is what was put on credit.
    const credit = input.payments.filter((x) => x.mode === 'CREDIT').reduce((s, x) => s + x.amount, 0);
    if (credit && !input.customerId) throw AppError.validation('Udhaar needs a customer — pick or add one first', [{ field: 'body.customerId', message: 'Pick a customer for udhaar' }]);
    const customer = input.customerId ? await customers.forBill(t, input.customerId, credit, session) : null;
    const cats = new Map((await CategoryModel.find({ shopId: t.shopId }).select('name').session(session).lean()).map((c) => [String(c._id), c.name]));
    const catOf = (x: { p: ProductLean }) => cats.get(String(x.p.categoryId)) ?? '';
    const rules = loyalty.rulesOf(shop.settings.loyalty);
    const points = await loyalty.forBill(t, rules, customer, { redeemPoints: input.redeemPoints, grandTotal: priced.grandTotal, lines: built.parts.map((x, i) => ({ category: catOf(x), totalAmount: priced.lines[i]?.amount ?? 0 })), canRedeem: can(t.permissions, 'loyalty', 'create'), now }, session);
    // Points pay first, then an order's advance; more advance than the rest goes back in cash.
    const toPay = priced.grandTotal - points.redeemValue;
    const advanceUsed = order ? Math.min(order.advance, toPay) : 0;
    const due = toPay - advanceUsed;
    const paid = input.payments.reduce((s, x) => s + x.amount, 0);
    if (paid !== due) {
      const less = [points.redeemValue ? `${inr(points.redeemValue)} points` : '', advanceUsed ? `${inr(advanceUsed)} advance` : ''].filter(Boolean).join(' and ');
      const what = less ? `the bill is ${inr(priced.grandTotal)} less ${less} = ${inr(due)}` : `the bill is ${inr(priced.grandTotal)}`;
      throw AppError.validation(`Payments add up to ${inr(paid)}, ${what}`, [{ field: 'body.payments', message: `Payments must add up to ${inr(due)}` }]);
    }
    const payments = [
      ...input.payments,
      ...(points.redeem ? [{ mode: 'POINTS' as const, amount: points.redeemValue, reference: `${String(points.redeem)} pts` }] : []),
      ...(order && advanceUsed ? [{ mode: 'ADVANCE' as const, amount: advanceUsed, reference: order.orderNumber }] : []),
    ];
    const cash = input.payments.filter((x) => x.mode === 'CASH').reduce((s, x) => s + x.amount, 0);
    if (input.cashReceived !== undefined && input.cashReceived < cash) throw AppError.validation('Cash received is less than the cash part', [{ field: 'body.cashReceived', message: 'Less than the cash part' }]);

    const lines = built.parts.map((x, i) => {
      const r = priced.lines[i];
      if (!r) throw AppError.internal();
      const u = x.p.units as Units;
      const lineCost = x.qtyBase * x.b.costPerBaseUnit;
      const floor = floorOf(x.b.minPrice, x.qtyBase, x.salePack);
      return {
        item: x.item,
        productId: x.p._id,
        productName: x.p.name,
        category: catOf(x),
        hsn: x.p.hsnCode,
        schedule: x.p.scheduleType,
        batchId: x.b._id,
        batchNumber: x.b.batchNumber,
        expiryDate: x.b.expiryDate,
        quantityInBase: x.qtyBase,
        unit: u.sale,
        baseUnit: u.base,
        salePack: x.salePack,
        mrp: x.mrp,
        gross: r.gross,
        lineDiscount: r.lineDiscount,
        billDiscountShare: r.billShare,
        discountAmount: r.discount,
        typedPrice: x.sell !== null,
        aboveMrpAmount: r.aboveMrp,
        minPrice: x.b.minPrice ?? undefined,
        belowMinPrice: floor !== null && r.amount < floor,
        gstRate: x.gstRate,
        taxableAmount: r.taxable,
        cgst: r.cgst,
        sgst: r.sgst,
        igst: r.igst,
        totalAmount: r.amount,
        costPerBaseUnit: x.b.costPerBaseUnit,
        lineCost,
        lineProfit: r.taxable - lineCost,
        returnedQuantity: 0,
        noPoints: !loyalty.earnsPoints(catOf(x), rules),
      };
    });

    const saleId = new Types.ObjectId();
    const billNumber = await nextNumber(t.shopId, 'sale', now, session, billing.billPrefix);
    for (const l of lines) {
      await applyMove(t.shopId, l.batchId, -l.quantityInBase, { type: 'SALE', refType: 'SALE', refId: saleId, refNumber: billNumber, actor, at: now }, session);
    }
    const pts = customer ? await loyalty.afterBill(t, rules, customer, { saleId, billNumber, redeem: points.redeem, earned: points.earned, actor, at: now }, session) : null;
    const modes = [...new Set(payments.map((x) => x.mode))];
    const totalCost = lines.reduce((s, l) => s + l.lineCost, 0);
    const discountAboveLimit = priced.discountPercent > billing.maxDiscountPercent;
    const belowMinPrice = lines.some((l) => l.belowMinPrice);
    await SaleModel.create(
      [
        {
          _id: saleId,
          shopId: t.shopId,
          fy: fyOf(now),
          clientRequestId: input.clientRequestId,
          billNumber,
          billDate: now,
          customerId: customer?._id,
          customerName: customer?.name ?? (input.customer?.name || 'Walk-in'),
          customerPhone: customer?.phone ?? input.customer?.phone ?? '',
          doctorId: doctor?._id,
          doctorName,
          patientName: input.rx?.patientName ?? '',
          rxNumber: input.rx?.rxNumber ?? '',
          rxDate: input.rx?.rxDate,
          orderId: order?._id,
          orderNumber: order?.orderNumber,
          lines,
          subtotal: priced.subtotal,
          lineDiscountAmount: priced.lineDiscount,
          billDiscountAmount: priced.billDiscount,
          totalDiscount: priced.totalDiscount,
          discountPercent: priced.discountPercent,
          discountAboveLimit,
          discountLimitPercent: billing.maxDiscountPercent,
          aboveMrpAmount: priced.aboveMrp,
          belowMinPrice,
          taxableAmount: priced.taxable,
          cgst: priced.cgst,
          sgst: priced.sgst,
          igst: priced.igst,
          totalTax: priced.totalTax,
          roundOff: priced.roundOff,
          grandTotal: priced.grandTotal,
          toPay,
          loyaltyPointsRedeemed: points.redeem,
          loyaltyDiscountAmount: points.redeemValue,
          loyaltyPointsEarned: points.earned,
          loyaltyBalanceAfter: pts?.balance,
          payments,
          paymentMode: modes.length > 1 ? 'SPLIT' : (modes[0] ?? 'NONE'),
          cashReceived: input.cashReceived,
          paidAmount: paid - credit + advanceUsed + points.redeemValue,
          dueAmount: credit,
          paymentStatus: !credit ? 'paid' : credit === priced.grandTotal ? 'credit' : 'partial',
          totalCost,
          grossProfit: priced.taxable - totalCost,
          createdBy: oid(actor.id),
          createdByName: actor.name,
        },
      ],
      { session },
    );
    if (order) await orders.complete(t, order, { id: saleId, billNumber, at: now, advanceUsed }, session);
    if (customer) await customers.afterBill(t, customer, { total: toPay, credit, at: now }, session);
    const productIds = [...new Set(lines.map((l) => String(l.productId)))].map(oid);
    await ProductModel.updateMany({ shopId: t.shopId, _id: { $in: productIds } }, { $set: { lastSoldAt: now } }, { session });
    await refreshRollups(t.shopId, productIds, session, now);
    // D43: no approval, but the owner hears of it; a tier up is news for whoever looks after customers.
    if (discountAboveLimit) {
      await emit(t.shopId, { key: `LARGE_DISCOUNT:${billNumber}`, type: 'LARGE_DISCOUNT', priority: 'medium', title: `${billNumber}: ${String(priced.discountPercent)}% discount — above the ${String(billing.maxDiscountPercent)}% limit`, body: `${actor.name} gave ${inr(priced.totalDiscount)} off a ${inr(priced.subtotal)} bill. It is in the discount register.`, route: `/sales/${String(saleId)}`, roles: ['owner'] }, session);
    }
    if (customer && pts?.tierUp) {
      await emit(t.shopId, { key: `LOYALTY_TIER_UP:${String(customer._id)}:${pts.tierUp.to}`, type: 'LOYALTY_TIER_UP', priority: 'low', title: `${customer.name} moved up to ${pts.tierUp.to}`, body: `On ${billNumber} — earns more points from the next bill.`, route: `/customers/${String(customer._id)}`, perm: { module: 'customers', action: 'view' } }, session);
    }
    const flags = [
      discountAboveLimit ? `discount ${String(priced.discountPercent)}% is above the ${String(billing.maxDiscountPercent)}% limit` : '',
      priced.aboveMrp ? `${inr(priced.aboveMrp)} above MRP` : '',
      belowMinPrice ? 'sold under the lowest price' : '',
      credit ? `udhaar ${inr(credit)} to ${customer?.name ?? ''}` : '',
      points.redeem ? `${String(points.redeem)} points used (${inr(points.redeemValue)})` : '',
      order ? `order ${order.orderNumber}${advanceUsed ? `, advance ${inr(advanceUsed)}` : ''}${order.advance > advanceUsed ? `, ${inr(order.advance - advanceUsed)} advance given back` : ''}` : '',
    ].filter(Boolean);
    await audit(
      { shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'create', module: 'sales', entityId: String(saleId), entityName: billNumber, text: `${actor.name} billed ${billNumber} · ${inr(priced.grandTotal)} · ${String(lines.length)} ${lines.length === 1 ? 'line' : 'lines'}${flags.length ? ` · ${flags.join(' · ')}` : ''}`, ip },
      session,
    );
    return {
      id: String(saleId),
      billNumber,
      grandTotal: priced.grandTotal,
      change: input.cashReceived !== undefined ? input.cashReceived - cash : 0,
      advanceUsed,
      advanceBack: order ? order.advance - advanceUsed : 0,
      pointsRedeemed: points.redeem,
      pointsEarned: points.earned,
      pointsBalance: pts?.balance ?? null,
      tierUp: pts?.tierUp ?? null,
    };
  });
}

type SaleLean = NonNullable<Awaited<ReturnType<typeof findSale>>>;
async function findSale(t: TenantContext, userId: string, id: string) {
  const filter: Record<string, unknown> = { shopId: t.shopId, _id: oid(id) };
  if (ownOnly(t)) filter.createdBy = oid(userId);
  return SaleModel.findOne(filter).lean();
}

function shape(s: SaleLean, cost: boolean) {
  const now = new Date();
  return {
    id: String(s._id),
    billNumber: s.billNumber,
    billDate: s.billDate,
    customerId: s.customerId ? String(s.customerId) : null,
    customerName: s.customerName,
    customerPhone: s.customerPhone,
    doctorName: s.doctorName,
    patientName: s.patientName,
    rxNumber: s.rxNumber,
    rxDate: s.rxDate ?? null,
    orderId: s.orderId ? String(s.orderId) : null,
    orderNumber: s.orderNumber ?? null,
    lines: s.lines.map((l) => ({
      item: l.item,
      productId: String(l.productId),
      productName: l.productName,
      hsn: l.hsn,
      schedule: l.schedule,
      batchId: String(l.batchId),
      batchNumber: l.batchNumber,
      expiryDate: hasExpiry(l.expiryDate) ? l.expiryDate : null,
      daysLeft: daysLeftOut(l.expiryDate, now),
      quantityInBase: l.quantityInBase,
      unit: l.unit,
      baseUnit: l.baseUnit,
      salePack: l.salePack,
      mrp: l.mrp,
      gross: l.gross,
      lineDiscount: l.lineDiscount,
      billDiscountShare: l.billDiscountShare,
      discountAmount: l.discountAmount,
      typedPrice: l.typedPrice,
      aboveMrpAmount: l.aboveMrpAmount,
      minPrice: l.minPrice ?? null,
      belowMinPrice: l.belowMinPrice,
      gstRate: l.gstRate,
      taxableAmount: l.taxableAmount,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
      totalAmount: l.totalAmount,
      returnedQuantity: l.returnedQuantity,
      noPoints: l.noPoints ?? false,
      ...(cost ? { costPerBaseUnit: l.costPerBaseUnit, lineCost: l.lineCost, lineProfit: l.lineProfit } : {}),
    })),
    subtotal: s.subtotal,
    lineDiscountAmount: s.lineDiscountAmount,
    billDiscountAmount: s.billDiscountAmount,
    totalDiscount: s.totalDiscount,
    discountPercent: s.discountPercent,
    discountAboveLimit: s.discountAboveLimit,
    discountLimitPercent: s.discountLimitPercent,
    aboveMrpAmount: s.aboveMrpAmount,
    belowMinPrice: s.belowMinPrice,
    taxableAmount: s.taxableAmount,
    cgst: s.cgst,
    sgst: s.sgst,
    igst: s.igst,
    totalTax: s.totalTax,
    roundOff: s.roundOff,
    grandTotal: s.grandTotal,
    toPay: s.toPay,
    loyaltyPointsRedeemed: s.loyaltyPointsRedeemed ?? 0,
    loyaltyDiscountAmount: s.loyaltyDiscountAmount ?? 0,
    loyaltyPointsEarned: s.loyaltyPointsEarned ?? 0,
    loyaltyBalanceAfter: s.loyaltyBalanceAfter ?? null,
    loyaltyPointsReversed: s.loyaltyPointsReversed ?? 0,
    loyaltyPointsRestored: s.loyaltyPointsRestored ?? 0,
    payments: s.payments.map((p) => ({ mode: p.mode, amount: p.amount, reference: p.reference })),
    paymentMode: s.paymentMode,
    cashReceived: s.cashReceived ?? null,
    paidAmount: s.paidAmount,
    dueAmount: s.dueAmount,
    paymentStatus: s.paymentStatus,
    status: s.status,
    cancelReason: s.cancelReason ?? null,
    cancelledBy: s.cancelledBy ?? null,
    cancelledAt: s.cancelledAt ?? null,
    createdBy: String(s.createdBy),
    createdByName: s.createdByName,
    ...(cost ? { totalCost: s.totalCost, grossProfit: s.grossProfit } : {}),
  };
}

export async function get(t: TenantContext, userId: string, id: string) {
  const s = await findSale(t, userId, id);
  if (!s) throw AppError.notFound('Bill not found');
  const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings.billing.saleReturnWindowDays').lean();
  const rets = await SaleReturnModel.find({ shopId: t.shopId, saleId: s._id }).sort({ returnDate: 1 }).select('returnNumber creditNoteNumber returnDate total refundMode createdByName').lean();
  return {
    ...shape(s, seesCost(t)),
    ageDays: ageDays(s.billDate, new Date()),
    returnWindowDays: shop?.settings.billing?.saleReturnWindowDays ?? 7,
    returns: rets.map((r) => ({ id: String(r._id), returnNumber: r.returnNumber, creditNoteNumber: r.creditNoteNumber ?? null, returnDate: r.returnDate, total: r.total, refundMode: r.refundMode, createdByName: r.createdByName })),
  };
}

const dayEnd = (d: Date) => new Date(d.getTime() + DAY - 1);

function listFilter(t: TenantContext, userId: string, q: Pick<SaleListQuery, 'from' | 'to' | 'status' | 'paymentMode' | 'userId' | 'flag' | 'q' | 'customerId'>) {
  const filter: Record<string, unknown> = { shopId: t.shopId };
  if (ownOnly(t)) filter.createdBy = oid(userId);
  else if (q.userId) filter.createdBy = oid(q.userId);
  if (q.status) filter.status = q.status;
  if (q.paymentMode) filter.paymentMode = q.paymentMode;
  if (q.flag === 'discount') filter.discountAboveLimit = true;
  if (q.flag === 'aboveMrp') filter.aboveMrpAmount = { $gt: 0 };
  if (q.flag === 'belowMin') filter.belowMinPrice = true;
  if (q.customerId) filter.customerId = oid(q.customerId);
  // Digits only can also be the customer's phone (return lookup, PLAN §15).
  if (q.q) {
    const bill = { billNumber: { $regex: `${escape(q.q.toUpperCase())}$` } };
    filter.$or = /^\d{4,}$/.test(q.q) ? [bill, { customerPhone: { $regex: escape(q.q) } }] : [bill];
  }
  if (q.from || q.to) filter.billDate = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: dayEnd(q.to) } : {}) };
  return filter;
}

export async function list(t: TenantContext, userId: string, q: SaleListQuery) {
  const filter = listFilter(t, userId, q);
  const sort = { field: 'billDate', dir: -1 as const };
  const after = afterCursor(q.cursor, sort);
  const rows = await SaleModel.find(Object.keys(after).length ? { ...filter, $and: [after] } : filter)
    .sort({ billDate: -1, _id: -1 })
    .limit(q.limit + 1)
    .select('billNumber billDate customerName lines.productName lines.quantityInBase grandTotal totalDiscount discountAboveLimit aboveMrpAmount belowMinPrice paymentMode status createdByName')
    .lean();
  const { items, meta } = page(rows, q.limit, (r) => r.billDate);
  return {
    items: items.map((s) => ({
      id: String(s._id),
      billNumber: s.billNumber,
      billDate: s.billDate,
      customerName: s.customerName,
      items: s.lines.length,
      firstItem: s.lines[0]?.productName ?? '',
      grandTotal: s.grandTotal,
      totalDiscount: s.totalDiscount,
      discountAboveLimit: s.discountAboveLimit,
      aboveMrpAmount: s.aboveMrpAmount,
      belowMinPrice: s.belowMinPrice,
      paymentMode: s.paymentMode,
      status: s.status,
      createdByName: s.createdByName,
    })),
    meta,
  };
}

/** Tiles for a date range; cancelled bills count only in `cancelled`. */
export async function summary(t: TenantContext, userId: string, from: Date, to: Date) {
  const base = listFilter(t, userId, { from, to });
  const [r] = await SaleModel.aggregate<{ bills: number; total: number; discount: number; cash: number; upi: number; card: number }>([
    { $match: { ...base, status: { $ne: 'cancelled' } } },
    { $unwind: { path: '$payments', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: '$_id',
        total: { $first: '$grandTotal' },
        discount: { $first: '$totalDiscount' },
        cash: { $sum: { $cond: [{ $eq: ['$payments.mode', 'CASH'] }, '$payments.amount', 0] } },
        upi: { $sum: { $cond: [{ $eq: ['$payments.mode', 'UPI'] }, '$payments.amount', 0] } },
        card: { $sum: { $cond: [{ $eq: ['$payments.mode', 'CARD'] }, '$payments.amount', 0] } },
      },
    },
    { $group: { _id: null, bills: { $sum: 1 }, total: { $sum: '$total' }, discount: { $sum: '$discount' }, cash: { $sum: '$cash' }, upi: { $sum: '$upi' }, card: { $sum: '$card' } } },
  ]);
  const cancelled = await SaleModel.countDocuments({ ...base, status: 'cancelled' });
  return { bills: r?.bills ?? 0, total: r?.total ?? 0, discount: r?.discount ?? 0, cash: r?.cash ?? 0, upi: r?.upi ?? 0, card: r?.card ?? 0, cancelled };
}

/** Cancel (sales:approve, PLAN §22): every unit goes back to its own batch; only a bill with no return yet. */
export async function cancel(t: TenantContext, actor: Actor, id: string, reason: string, ip?: string) {
  return inTransaction(async (session) => {
    const now = new Date();
    const s = await SaleModel.findOne({ shopId: t.shopId, _id: oid(id) }).session(session).lean();
    if (!s) throw AppError.notFound('Bill not found');
    if (s.status === 'cancelled') throw AppError.conflict(`${s.billNumber} is already cancelled`);
    if (s.status !== 'completed') throw AppError.conflict(`${s.billNumber} has a return — cancel isn’t possible now. Return the rest instead.`);
    const earned = s.loyaltyPointsEarned ?? 0;
    const redeemed = s.loyaltyPointsRedeemed ?? 0;
    const done = await SaleModel.updateOne(
      { shopId: t.shopId, _id: s._id, status: 'completed', dueAmount: s.dueAmount },
      { $set: { status: 'cancelled', cancelReason: reason, cancelledBy: actor.name, cancelledAt: now, cancelledDue: s.dueAmount, dueAmount: 0, loyaltyPointsReversed: earned, loyaltyPointsRestored: redeemed } },
      { session },
    );
    if (!done.modifiedCount) throw AppError.conflict(`${s.billNumber} changed meanwhile — reload`);
    for (const l of s.lines) {
      await applyMove(t.shopId, l.batchId, l.quantityInBase, { type: 'SALE_CANCEL', refType: 'SALE', refId: s._id, refNumber: s.billNumber, reason, actor, at: now }, session);
    }
    await refreshRollups(t.shopId, [...new Set(s.lines.map((l) => String(l.productId)))].map(oid), session, now);
    if (s.customerId) await customers.takeBack(t, s.customerId, { spend: s.toPay, credit: s.dueAmount, visit: true }, session);
    // Cancel is only before any return, so the whole bill's points move.
    const moved = await loyalty.takeBack(t, await loyalty.rules(t, session), s, { reverse: earned - (s.loyaltyPointsReversed ?? 0), restore: redeemed - (s.loyaltyPointsRestored ?? 0), refType: 'SALE', refId: s._id, refNumber: s.billNumber, reason: 'Bill cancelled', actor, at: now }, session);
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'cancel', module: 'sales', entityId: String(s._id), entityName: s.billNumber, text: `${actor.name} cancelled ${s.billNumber} · ${inr(s.grandTotal)} · reason: ${reason}${moved.reversed || moved.restored ? ` · points −${String(moved.reversed)} / +${String(moved.restored)}` : ''}`, ip }, session);
    return { id: String(s._id), billNumber: s.billNumber, pointsReversed: moved.reversed, pointsRestored: moved.restored };
  });
}

/** For the bill PDF and the QR (PLAN §35.7). */
export async function forPdf(t: TenantContext, userId: string, id: string) {
  const s = await findSale(t, userId, id);
  if (!s) throw AppError.notFound('Bill not found');
  return shape(s, false);
}
