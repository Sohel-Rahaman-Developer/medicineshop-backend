import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { versionOf } from '../../core/version';
import { monthEnd, objectId, paise } from '../../core/zod';
import { inr, rhu } from '../../utils/money';
import { fromBase, salePack, type Units } from '../../utils/units';
import { audit } from '../audit/audit.model';
import { assertRate } from '../tax/tax.service';
import { taxRate } from '../tax/tax.validation';
import { BatchModel } from '../stock/batch.model';
import { MovementModel } from '../stock/movement.model';
import { ensureRack, refreshRollups } from '../stock/stock.ledger';
import type { Actor } from '../user/actor';
import { ProductModel } from './product.model';
import { searchKeyOf, seesCost, sellChange } from './products.service';
import { rackCode } from './products.validation';

const PAGE = 100;

export const gridQuerySchema = z.object({ q: z.string().trim().max(60).default(''), page: z.coerce.number().int().min(0).max(1000).default(0) }).strict();
export type GridQuery = z.infer<typeof gridQuerySchema>;

export const gridSaveSchema = z
  .object({
    products: z
      .array(
        z
          .object({
            id: objectId,
            version: z.number().int().nonnegative(),
            name: z.string().trim().min(2, 'Give the product a name').max(120).transform((v) => v.replace(/\s+/g, ' ')).optional(),
            company: z.string().trim().max(80).optional(),
            gstRate: taxRate.optional(),
            sellPrice: paise('Sell price').min(1, 'Sell price must be more than ₹0').nullable().optional(),
            defaultRack: rackCode.optional(),
          })
          .strict(),
      )
      .max(300),
    batches: z
      .array(
        z
          .object({
            id: objectId,
            batchNumber: z.string().trim().min(1, 'Batch number is required').max(20).regex(/^[A-Za-z0-9/-]+$/, 'Use letters, numbers, / and -').optional(),
            expiry: monthEnd.optional(),
            /** Base units. */
            quantity: z.number().int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(10_000_000).optional(),
            mrp: paise('MRP').min(1, 'MRP is required').optional(),
            /** Paise per sale unit, before GST. */
            purchaseRate: paise('Purchase rate').optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type GridSave = z.infer<typeof gridSaveSchema>;

/** Only stock typed in by hand and not touched since (one OPENING move, nothing sold or moved) can be put right in place. */
const LOCKED_WHY = 'Stock has been sold or moved from this batch — change it with an adjustment';

/** The shop's products with their batches in stock, a page at a time, for the edit grid. */
export async function gridRows(t: TenantContext, q: GridQuery) {
  const filter: Record<string, unknown> = { shopId: t.shopId, isActive: true };
  if (q.q) filter.nameLower = { $regex: q.q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  const list = await ProductModel.find(filter).sort({ nameLower: 1, _id: 1 }).skip(q.page * PAGE).limit(PAGE + 1).lean();
  const products = list.slice(0, PAGE);
  const batches = await BatchModel.find({ shopId: t.shopId, productId: { $in: products.map((p) => p._id) }, status: { $ne: 'returned' }, quantity: { $gt: 0 } }).sort({ expiryDate: 1, _id: 1 }).lean();
  const moves = await MovementModel.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { shopId: t.shopId, batchId: { $in: batches.map((b) => b._id) } } }, { $group: { _id: '$batchId', n: { $sum: 1 } } }]);
  const moved = new Map(moves.map((m) => [String(m._id), m.n]));
  const cost = seesCost(t);
  return {
    products: products.map((p) => {
      const units = p.units as Units;
      return {
        id: String(p._id),
        version: (p as { version?: number }).version ?? 0,
        name: p.name,
        company: p.company,
        gstRate: p.gstRate,
        sellPrice: p.sellPrice ?? null,
        defaultRack: p.defaultRack,
        noExpiry: p.noExpiry,
        units: { base: units.base, sale: units.sale, salePack: salePack(units), purchase: units.purchase },
        batches: batches
          .filter((b) => b.productId.equals(p._id))
          .map((b) => {
            const editable = b.source === 'opening' && b.status === 'active' && b.quantity === b.initialQuantity && moved.get(String(b._id)) === 1;
            return {
              id: String(b._id),
              batchNumber: b.batchNumber,
              expiryDate: b.expiryDate,
              quantity: b.quantity,
              mrp: b.mrp,
              ...(cost ? { purchaseRate: b.purchaseRate, purchaseUnit: b.purchaseUnit } : {}),
              editable: editable && cost,
              locked: editable ? (cost ? null : 'Only people who see costs can correct a batch') : LOCKED_WHY,
            };
          }),
      };
    }),
    more: list.length > PAGE,
  };
}

const fail = (field: string, message: string) => AppError.validation(message, [{ field, message }]);

/** Saves the edit grid: product details and hand-typed batches put right, all or nothing. */
export async function saveGrid(t: TenantContext, actor: Actor, input: GridSave, ip?: string) {
  if (input.batches.length && !seesCost(t)) throw AppError.forbidden('Only people who see costs can correct a batch');
  for (const p of input.products) if (p.gstRate !== undefined) await assertRate(t, p.gstRate);
  const now = new Date();
  return inTransaction(async (session) => {
    const touched = new Set<string>();
    let products = 0;
    for (const [i, x] of input.products.entries()) {
      const at = `body.products.${String(i)}`;
      const doc = await ProductModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(x.id) }).session(session);
      if (!doc) throw fail(`${at}.name`, 'Product not found');
      if (versionOf(doc) !== x.version) throw fail(`${at}.name`, `Someone else changed ${doc.name}. Reload to see the latest.`);
      const notes: string[] = [];
      if (x.name !== undefined && x.name !== doc.name) {
        notes.push(`name ${doc.name} → ${x.name}`);
        doc.set({ name: x.name, nameLower: x.name.toLowerCase(), searchKey: searchKeyOf({ name: x.name, salt: doc.salt, company: x.company ?? doc.company }) });
      }
      if (x.company !== undefined && x.company !== doc.company) {
        notes.push(`company “${doc.company}” → “${x.company}”`);
        doc.set({ company: x.company, searchKey: searchKeyOf({ name: x.name ?? doc.name, salt: doc.salt, company: x.company }) });
      }
      if (x.gstRate !== undefined && x.gstRate !== doc.gstRate) {
        notes.push(`GST ${String(doc.gstRate)}% → ${String(x.gstRate)}%`);
        doc.set({ gstRate: x.gstRate });
      }
      const sell = sellChange(doc.sellPrice, x.sellPrice);
      if (sell) {
        notes.push(sell);
        doc.set({ sellPrice: x.sellPrice ?? undefined, sellPriceAt: now });
      }
      if (x.defaultRack !== undefined && x.defaultRack !== doc.defaultRack) {
        await ensureRack(t.shopId, x.defaultRack, doc.storageType === 'COLD' ? 'COLD' : 'NORMAL', session);
        notes.push(`rack ${doc.defaultRack || '—'} → ${x.defaultRack || '—'}`);
        doc.set({ defaultRack: x.defaultRack });
      }
      if (!notes.length) continue;
      await doc.save({ session }).catch((err: unknown) => {
        if ((err as { code?: number }).code === 11000) throw fail(`${at}.name`, 'A product with this name already exists');
        throw err;
      });
      await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'products', entityId: x.id, entityName: doc.name, text: `${actor.name} updated product ${doc.name} (edit grid): ${notes.join(' · ')}`, ip }, session);
      touched.add(x.id);
      products++;
    }

    let batches = 0;
    for (const [i, x] of input.batches.entries()) {
      const at = `body.batches.${String(i)}`;
      const b = await BatchModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(x.id) }).session(session);
      if (!b) throw fail(`${at}.batchNumber`, 'Batch not found');
      const moves = await MovementModel.find({ shopId: t.shopId, batchId: b._id }).session(session);
      const opening = moves[0];
      if (b.source !== 'opening' || b.status !== 'active' || b.quantity !== b.initialQuantity || moves.length !== 1 || opening?.type !== 'OPENING') throw fail(`${at}.batchNumber`, LOCKED_WHY);
      const p = await ProductModel.findOne({ shopId: t.shopId, _id: b.productId }).select('name units noExpiry lastMrp').session(session).lean();
      if (!p) throw AppError.internal();
      const units = p.units as Units;
      const pack = salePack(units);
      const next = {
        batchNumber: x.batchNumber?.toUpperCase() ?? b.batchNumber,
        expiryDate: p.noExpiry || !x.expiry ? b.expiryDate : x.expiry,
        quantity: x.quantity ?? b.quantity,
        mrp: x.mrp ?? b.mrp,
        purchaseRate: x.purchaseRate ?? b.purchaseRate,
      };
      if (x.quantity !== undefined && x.quantity % pack !== 0 && !units.allowLooseSale) throw fail(`${at}.quantity`, `Quantity must be whole ${units.sale.toLowerCase()}s`);
      const notes: string[] = [];
      if (next.batchNumber !== b.batchNumber) notes.push(`batch ${b.batchNumber} → ${next.batchNumber}`);
      if (next.expiryDate.getTime() !== b.expiryDate.getTime()) notes.push('expiry changed');
      if (next.quantity !== b.quantity) notes.push(`quantity ${fromBase(b.quantity, units)} → ${fromBase(next.quantity, units)}`);
      if (next.mrp !== b.mrp) notes.push(`MRP ${inr(b.mrp)} → ${inr(next.mrp)}`);
      if (next.purchaseRate !== b.purchaseRate) notes.push(`rate ${inr(b.purchaseRate)} → ${inr(next.purchaseRate)}`);
      if (!notes.length) continue;
      if (next.batchNumber !== b.batchNumber || next.expiryDate.getTime() !== b.expiryDate.getTime()) {
        const clash = await BatchModel.exists({ shopId: t.shopId, productId: b.productId, _id: { $ne: b._id }, batchNumberUpper: next.batchNumber.toUpperCase(), expiryDate: next.expiryDate }).session(session);
        if (clash) throw fail(`${at}.batchNumber`, `Batch ${next.batchNumber} with this expiry is already in stock`);
      }
      const cost = rhu(next.purchaseRate, pack);
      const oldMrp = b.mrp;
      b.set({ ...next, batchNumberUpper: next.batchNumber.toUpperCase(), initialQuantity: next.quantity, costPerBaseUnit: cost });
      await b.save({ session });
      opening.set({ quantity: next.quantity, balanceAfter: opening.balanceBefore + next.quantity, costPerBaseUnit: cost, refNumber: next.batchNumber });
      await opening.save({ session });
      if (p.lastMrp === oldMrp && next.mrp !== oldMrp) await ProductModel.updateOne({ shopId: t.shopId, _id: b.productId }, { $set: { lastMrp: next.mrp } }, { session });
      await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'stock', entityId: String(b._id), entityName: `${p.name} · ${next.batchNumber}`, text: `${actor.name} corrected opening stock of ${p.name} (edit grid): ${notes.join(' · ')}`, ip }, session);
      touched.add(String(b.productId));
      batches++;
    }
    await refreshRollups(t.shopId, [...touched].map((id) => new Types.ObjectId(id)), session, now);
    return { products, batches };
  });
}
