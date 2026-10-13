import { randomBytes } from 'node:crypto';
import { Schema, Types, model } from 'mongoose';
import sharp from 'sharp';
import type { TenantContext } from '../../core/middleware/tenant';
import { audit } from '../audit/audit.model';
import { processLogo } from '../branding/branding.service';
import { bytesOf } from '../products/photo';
import type { Actor } from '../user/actor';
import { ShopModel } from './shop.model';

// Apart from the shop document, so the bytes never ride along with every shop read.
const shopLogoSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    png: { type: Buffer, required: true },
    version: { type: Number, required: true, default: 1 },
    updatedBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
export const ShopLogoModel = model('ShopLogo', shopLogoSchema);

const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () => Array.from(randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

/** D92: the shop's public code — its loyalty QR page and logo URL; made once, the first time it is needed. */
export async function publicCodeOf(shopId: Types.ObjectId): Promise<string> {
  const have = await ShopModel.findById(shopId).select('publicCode').lean();
  if (have?.publicCode) return have.publicCode;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const r = await ShopModel.updateOne({ _id: shopId, publicCode: { $exists: false } }, { $set: { publicCode: code } }).catch((err: unknown) => {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    });
    if (r) break;
  }
  return (await ShopModel.findById(shopId).select('publicCode').lean())?.publicCode ?? '';
}

/** The logo's path under the API (with its version, so a new one isn't served from cache), or null for MedBox24's. */
export async function logoPathOf(shopId: Types.ObjectId): Promise<string | null> {
  const l = await ShopLogoModel.findById(shopId).select('version').lean();
  return l ? `/public/shops/${await publicCodeOf(shopId)}/logo.png?v=${String(l.version)}` : null;
}

export async function logoBytes(shopId: Types.ObjectId) {
  return bytesOf((await ShopLogoModel.findById(shopId).select('png').lean())?.png);
}

/** D93: the same checks as MedBox24's own logo (real image, square, 256 px+), kept as a 512 px PNG. */
export async function setShopLogo(t: TenantContext, actor: Actor, dataUrl: string, ip?: string) {
  const { mark } = await processLogo(dataUrl);
  const png = await sharp(mark).resize(512, 512).png({ compressionLevel: 9 }).toBuffer();
  await ShopLogoModel.updateOne({ _id: t.shopId }, { $set: { png, updatedBy: actor.name }, $inc: { version: 1 } }, { upsert: true });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'settings', entityId: String(t.shopId), entityName: t.shopName, text: 'Uploaded the shop logo', ip });
  return { logo: await logoPathOf(t.shopId) };
}

export async function removeShopLogo(t: TenantContext, actor: Actor, ip?: string) {
  await ShopLogoModel.deleteOne({ _id: t.shopId });
  await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'settings', entityId: String(t.shopId), entityName: t.shopName, text: 'Removed the shop logo — MedBox24’s shows again', ip });
  return { logo: null };
}
