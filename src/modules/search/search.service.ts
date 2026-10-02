import type { TenantContext } from '../../core/middleware/tenant';
import { fromBase, type Units } from '../../utils/units';
import { list as listProducts } from '../products/products.service';
import { listQuerySchema } from '../products/products.validation';
import { ProductModel } from '../products/product.model';
import { PurchaseModel } from '../purchases/purchase.model';
import { can } from '../rbac/permissions';
import { BatchModel } from '../stock/batch.model';
import { SupplierModel } from '../suppliers/supplier.model';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Command palette (SANDBOX §6.1): each group only for those who may open it. Bills and customers join in B4 / B5. */
export async function search(t: TenantContext, q: string) {
  const p = t.permissions;
  const upper = q.toUpperCase().replace(/\s+/g, '');
  const [medicines, batches, suppliers, purchases] = await Promise.all([
    can(p, 'products', 'view') ? listProducts(t, listQuerySchema.parse({ q, limit: 6 })).then((r) => r.items) : [],
    can(p, 'products', 'view') && upper.length >= 3
      ? BatchModel.find({ shopId: t.shopId, batchNumberUpper: { $regex: `^${escape(upper)}` }, status: { $ne: 'returned' } }).sort({ expiryDate: 1 }).limit(4).lean()
      : [],
    can(p, 'suppliers', 'view') ? SupplierModel.find({ shopId: t.shopId, nameLower: { $regex: escape(q.toLowerCase()) } }).sort({ nameLower: 1 }).limit(3).lean() : [],
    can(p, 'purchases', 'view') && upper.length >= 3
      ? PurchaseModel.find({ shopId: t.shopId, $or: [{ purchaseNumber: { $regex: escape(upper) } }, { invoiceNumberLower: { $regex: `^${escape(q.toLowerCase())}` } }] })
          .sort({ invoiceDate: -1 })
          .limit(3)
          .select('purchaseNumber invoiceNumber supplierName grandTotal invoiceDate status')
          .lean()
      : [],
  ]);
  const owners = await ProductModel.find({ shopId: t.shopId, _id: { $in: batches.map((b) => b.productId) } }).select('name units').lean();
  const byId = new Map(owners.map((o) => [String(o._id), o]));
  return {
    medicines: medicines.map((m) => ({ id: m.id, name: m.name, sub: [`${m.salt} ${m.strength}`.trim(), m.company].filter(Boolean).join(' · '), photo: m.photo, rack: m.rack, cold: m.storageType === 'COLD', sellable: m.stock.sellable, units: m.units })),
    batches: batches.map((b) => {
      const o = byId.get(String(b.productId));
      return { id: String(b._id), productId: String(b.productId), batchNumber: b.batchNumber, productName: o?.name ?? '', expiryDate: b.expiryDate, left: o ? fromBase(b.quantity, o.units as Units) : String(b.quantity) };
    }),
    suppliers: suppliers.map((s) => ({ id: String(s._id), name: s.name, contactPerson: s.contactPerson, payableBalance: s.payableBalance })),
    purchases: purchases.map((x) => ({ id: String(x._id), purchaseNumber: x.purchaseNumber, invoiceNumber: x.invoiceNumber, supplierName: x.supplierName, grandTotal: x.grandTotal, invoiceDate: x.invoiceDate, status: x.status })),
  };
}
