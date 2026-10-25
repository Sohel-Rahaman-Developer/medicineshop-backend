import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { istDayStart } from '../../utils/date';
import { stateCodeOf } from '../../utils/india';
import { platform } from '../admin/platform';
import { audit } from '../audit/audit.model';
import { CategoryModel } from '../categories/category.model';
import { CustomerModel } from '../customers/customer.model';
import { MembershipModel } from '../memberships/membership.model';
import { ProductModel } from '../products/product.model';
import { RoleModel } from '../roles/role.model';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';
import { TermsAcceptanceModel } from '../shops/terms-acceptance.model';
import { SubscriptionModel, statusAt } from '../subscription/subscription.model';
import type { Actor } from '../user/actor';

// v1.25: a branch is its own shop (stock, bills, day close, staff, plan) opened from a main shop. Same state → it may
// share the main GSTIN with its own bill series; another state → its own GSTIN. Customers stay with each branch.

const MAX_BRANCHES = 20;
const COPY_CHUNK = 500;

export interface BranchInput {
  name: string;
  address: { line1: string; line2?: string; city: string; state: string; pincode: string };
  phone: string;
  email?: string;
  drugLicenseNumber: string;
  drugLicenseExpiry: Date;
  fssai?: string;
  gst: 'main' | 'own';
  gstin?: string;
  billPrefix: string;
}

/** The main shop of the shop in use, and every shop in its group the owner owns. */
async function groupOf(shopId: Types.ObjectId, ownerId: Types.ObjectId) {
  const here = await ShopModel.findById(shopId).select('mainShopId').lean();
  if (!here) throw AppError.notFound('Shop not found');
  const mainId = here.mainShopId ?? here._id;
  const shops = await ShopModel.find({ $or: [{ _id: mainId }, { mainShopId: mainId }], ownerUserId: ownerId, status: 'active' }).select('name address gstin settings.billing.billPrefix mainShopId createdAt').sort({ createdAt: 1 }).lean();
  return { mainId, shops };
}

function ownerOnly(t: TenantContext) {
  if (!t.isOwner) throw AppError.forbidden('Only the owner sees and opens branches');
}

/** Today in every shop of the group: sales, bills, udhaar to collect, medicines low or out, the plan. */
export async function overview(t: TenantContext, actor: Actor, now = new Date()) {
  ownerOnly(t);
  const { mainId, shops } = await groupOf(t.shopId, new Types.ObjectId(actor.id));
  const d0 = istDayStart(now);
  const rows = await Promise.all(
    shops.map(async (s) => {
      const [[sale], [due], [stock], sub] = await Promise.all([
        SaleModel.aggregate<{ total: number; bills: number }>([{ $match: { shopId: s._id, billDate: { $gte: d0 }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$grandTotal' }, bills: { $sum: 1 } } }]),
        CustomerModel.aggregate<{ total: number }>([{ $match: { shopId: s._id, creditBalance: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$creditBalance' } } }]),
        ProductModel.aggregate<{ low: number; out: number }>([{ $match: { shopId: s._id, isActive: true, 'stock.status': { $in: ['low', 'out'] } } }, { $group: { _id: null, low: { $sum: { $cond: [{ $eq: ['$stock.status', 'low'] }, 1, 0] } }, out: { $sum: { $cond: [{ $eq: ['$stock.status', 'out'] }, 1, 0] } } } }]),
        SubscriptionModel.findOne({ shopId: s._id }).select('status planCode endDate').lean(),
      ]);
      return {
        id: String(s._id),
        name: s.name,
        city: s.address?.city ?? '',
        state: s.address?.state ?? '',
        gstin: s.gstin ?? '',
        billPrefix: s.settings.billing?.billPrefix ?? 'INV',
        main: s._id.equals(mainId),
        here: s._id.equals(t.shopId),
        plan: sub ? statusAt(sub, now) : null,
        planEnds: sub?.endDate ?? null,
        today: { sales: sale?.total ?? 0, bills: sale?.bills ?? 0 },
        udhaar: due?.total ?? 0,
        low: stock?.low ?? 0,
        out: stock?.out ?? 0,
      };
    }),
  );
  const total = rows.reduce((a, r) => ({ sales: a.sales + r.today.sales, bills: a.bills + r.today.bills, udhaar: a.udhaar + r.udhaar }), { sales: 0, bills: 0, udhaar: 0 });
  const main = shops.find((s) => s._id.equals(mainId));
  return { rows, total, main: main ? { id: String(main._id), name: main.name, state: main.address?.state ?? '', gstin: main.gstin ?? '' } : null, canAdd: Boolean(main) && rows.length - 1 < MAX_BRANCHES };
}

/** Why this branch can't be opened as asked, in words; null when it can. */
function branchProblem(main: { address?: { stateCode: string } | null; gstin?: string | null }, input: BranchInput, taken: string[]) {
  const code = stateCodeOf(input.address.state);
  if (input.gst === 'main' && !main.gstin) return { field: 'gst', message: 'The main shop has no GSTIN — give this branch its own, or leave it empty' };
  if (input.gst === 'main' && main.address?.stateCode !== code) return { field: 'gst', message: 'A branch in another state needs its own GSTIN' };
  if (input.gst === 'own' && !input.gstin && main.gstin && main.address?.stateCode !== code) return { field: 'gstin', message: 'Your shop is GST registered — a branch in another state needs its own GSTIN' };
  if (taken.includes(input.billPrefix)) return { field: 'billPrefix', message: 'Another shop in your group uses this bill series' };
  return null;
}

/** The owner opens a branch from the main shop: settings, roles and the medicine list come along; stock starts at 0. */
export async function create(t: TenantContext, actor: Actor, input: BranchInput, ip?: string, now = new Date()) {
  ownerOnly(t);
  const uid = new Types.ObjectId(actor.id);
  const main = await ShopModel.findOne({ _id: t.shopId, ownerUserId: uid }).lean();
  if (!main) throw AppError.forbidden('Only the owner opens branches');
  if (main.mainShopId) throw AppError.conflict('Open branches from the main shop');
  const { shops } = await groupOf(t.shopId, uid);
  if (shops.length - 1 >= MAX_BRANCHES) throw AppError.conflict('At most 20 branches');
  const problem = branchProblem(main, input, shops.map((s) => s.settings.billing?.billPrefix ?? 'INV'));
  if (problem) throw AppError.validation(problem.message, [{ field: `body.${problem.field}`, message: problem.message }]);

  const [mainSub, trial] = await Promise.all([SubscriptionModel.findOne({ shopId: main._id }).select('status planCode endDate').lean(), platform()]);
  // No new free trial: a branch's trial ends with the main shop's; after it the branch takes its own plan.
  const trialEnd = mainSub && statusAt(mainSub, now) === 'trial' ? mainSub.endDate : now;
  const id = new Types.ObjectId();
  await inTransaction(async (session) => {
    await ShopModel.create(
      [
        {
          _id: id,
          name: input.name,
          legalName: main.legalName,
          ownerUserId: uid,
          mainShopId: main._id,
          address: { ...input.address, line2: input.address.line2 ?? '', stateCode: stateCodeOf(input.address.state) },
          phone: input.phone,
          email: input.email,
          gstin: input.gst === 'main' ? main.gstin : input.gstin,
          pan: main.pan,
          fssai: input.fssai,
          drugLicenseNumber: input.drugLicenseNumber,
          drugLicenseExpiry: input.drugLicenseExpiry,
          settings: { ...main.settings, billing: { ...main.settings.billing, billPrefix: input.billPrefix, openingFloat: 0 }, notifications: { ...main.settings.notifications, extraEmails: [] } },
        },
      ],
      { session },
    );
    const roles = await RoleModel.find({ shopId: main._id }).session(session).lean();
    const made = await RoleModel.create(
      roles.map((r) => ({ shopId: id, systemKey: r.systemKey ?? undefined, name: r.name, nameLower: r.nameLower, description: r.description, color: r.color, permissions: r.permissions as object, scopes: r.scopes as object, isSystem: r.isSystem, createdBy: uid })),
      { session, ordered: true },
    );
    const owner = made.find((r) => r.systemKey === 'owner');
    if (!owner) throw AppError.internal();
    await MembershipModel.create([{ shopId: id, userId: uid, roleId: owner._id, designation: 'Owner', status: 'active', joinedAt: now, lastActiveAt: now }], { session });
    await SubscriptionModel.create([{ shopId: id, planCode: 'trial', status: 'trial', startDate: now, endDate: trialEnd, maxUsers: trial.trialMaxUsers }], { session });
    const cats = await CategoryModel.find({ shopId: main._id }).session(session).lean();
    await CategoryModel.create(cats.map((c) => ({ shopId: id, name: c.name, key: c.key, isSystem: c.isSystem, createdBy: uid })), { session, ordered: true });
    await TermsAcceptanceModel.create([{ shopId: id, version: env.TERMS_VERSION, userId: uid, userName: actor.name, ip }], { session });
  });
  const copied = await copyProducts(main._id, id, uid, actor.name);
  const gst = input.gst === 'main' ? `the main GSTIN ${main.gstin ?? ''}` : input.gstin ? `GSTIN ${input.gstin}` : 'no GSTIN';
  await audit({ shopId: main._id, userId: actor.id, userName: actor.name, action: 'create', module: 'settings', entityId: String(id), entityName: input.name, text: `${actor.name} opened the branch ${input.name} (${input.address.city}) — ${gst}, bill series ${input.billPrefix}, ${String(copied)} medicines copied`, ip });
  await audit({ shopId: id, userId: actor.id, userName: actor.name, action: 'create', module: 'settings', entityId: String(id), entityName: input.name, text: `${actor.name} opened this branch from ${main.name} and accepted the Terms (${env.TERMS_VERSION})`, ip });
  return { id: String(id), name: input.name, copied, trialEnds: trialEnd > now ? trialEnd : null };
}

/** The main shop's medicine list, without stock: names, salts, HSN, GST, units, barcodes and photos. */
async function copyProducts(from: Types.ObjectId, to: Types.ObjectId, uid: Types.ObjectId, byName: string) {
  const [fromCats, toCats] = await Promise.all([CategoryModel.find({ shopId: from }).select('key').lean(), CategoryModel.find({ shopId: to }).select('key').lean()]);
  const keyOf = new Map(fromCats.map((c) => [String(c._id), c.key]));
  const idOf = new Map(toCats.map((c) => [c.key, c._id]));
  let copied = 0;
  let after: Types.ObjectId | null = null;
  for (;;) {
    const rows: Awaited<ReturnType<typeof page>> = await page(from, after);
    if (!rows.length) break;
    after = rows[rows.length - 1]?._id ?? null;
    const docs = rows.flatMap((p) => {
      const categoryId = idOf.get(keyOf.get(String(p.categoryId)) ?? '');
      if (!categoryId) return [];
      return [{ shopId: to, name: p.name, nameLower: p.nameLower, searchKey: p.searchKey, company: p.company, salt: p.salt, saltKey: p.saltKey, strength: p.strength, categoryId, scheduleType: p.scheduleType, storageType: p.storageType, hsnCode: p.hsnCode, gstRate: p.gstRate, barcode: p.barcode ?? undefined, altBarcodes: p.altBarcodes ?? undefined, units: p.units, packSize: p.packSize, noExpiry: p.noExpiry, reorderLevel: p.reorderLevel, reorderQuantity: p.reorderQuantity, photo: p.photo ?? null, isActive: true, createdBy: uid, createdByName: byName }];
    });
    // A medicine already there (a retry) is skipped by the unique name index; the rest still go in.
    const out = await ProductModel.insertMany(docs, { ordered: false }).catch((err: unknown) => {
      const e = err as { code?: number; writeErrors?: { code?: number }[]; insertedDocs?: unknown[] };
      if (e.code !== 11000 && !e.writeErrors?.every((w) => w.code === 11000)) throw err;
      return e.insertedDocs ?? [];
    });
    copied += out.length;
    if (rows.length < COPY_CHUNK) break;
  }
  return copied;
}

const page = (shopId: Types.ObjectId, after: Types.ObjectId | null) =>
  ProductModel.find({ shopId, isActive: true, ...(after ? { _id: { $gt: after } } : {}) })
    .sort({ _id: 1 })
    .limit(COPY_CHUNK)
    .select('name nameLower searchKey company salt saltKey strength categoryId scheduleType storageType hsnCode gstRate barcode altBarcodes units packSize noExpiry reorderLevel reorderQuantity photo')
    .lean();
