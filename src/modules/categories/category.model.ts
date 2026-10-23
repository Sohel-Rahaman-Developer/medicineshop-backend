import { Schema, model, type ClientSession, type Types } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { CategoryRequestModel } from './category-request.model';

export const SYSTEM_CATEGORIES = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 'Drops', 'Powder', 'Surgical', 'FMCG', 'Ayurvedic', 'Device', 'Chocolate & snacks', 'Drinks', 'Baby care', 'Personal care', 'Nutrition'];

/** "eye drops", "Eye-Drop" and "EYE DROPS " are one category (PLAN §35.9). */
export const categoryKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, '');

const categorySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    key: { type: String, required: true },
    isSystem: { type: Boolean, required: true, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
categorySchema.index({ shopId: 1, key: 1 }, { unique: true });
categorySchema.plugin(tenantScoped);

export const CategoryModel = model('Category', categorySchema);

/** The built-in list plus every category MedBox24 approved for all shops. */
export async function seedSystemCategories(shopId: Types.ObjectId, session: ClientSession): Promise<void> {
  const approved = (await CategoryRequestModel.find({ status: 'approved' }).select('name').sort({ decidedAt: 1 }).session(session).lean()).map((r) => r.name);
  const byKey = new Map([...SYSTEM_CATEGORIES, ...approved].map((name) => [categoryKey(name), name]));
  await CategoryModel.create(
    [...byKey].map(([key, name]) => ({ shopId, name, key, isSystem: true })),
    { session, ordered: true },
  );
}
