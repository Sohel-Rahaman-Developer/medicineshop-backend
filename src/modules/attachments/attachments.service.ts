import { Types } from 'mongoose';
import sharp from 'sharp';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { inTransaction } from '../../core/transaction';
import { audit } from '../audit/audit.model';
import { bytesOf, SIGNATURES } from '../products/photo';
import { PurchaseModel } from '../purchases/purchase.model';
import { SaleModel } from '../sales/sale.model';
import { AdjustmentModel } from '../stock/adjustment.model';
import type { Actor } from '../user/actor';
import { AttachmentModel, type AttachmentOwner } from './attachment.model';

const MAX_INPUT_BYTES = 600 * 1024;
const MAX_INPUT_PIXELS = 6000 * 6000;
/** A paper keeps its colour; a prescription is stored grey and smaller — handwriting reads the same, a year of bills stays small (D105). */
const PROFILE = { doc: { side: 1600, bytes: 400 * 1024, grey: false }, rx: { side: 1400, bytes: 150 * 1024, grey: true } } as const;
export type PhotoProfile = keyof typeof PROFILE;

const bad = (message: string) => AppError.validation(message, [{ field: 'body.photo', message }]);

/** A photo of a paper → WebP, longest side ≤ 1600 px, ≤ 400 KB (a prescription: grey, ≤ 1400 px, ≤ 150 KB); metadata dropped by the re-encode (D51). */
export async function processDocument(dataUrl: string, profile: PhotoProfile = 'doc') {
  const p = PROFILE[profile];
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m?.[1] || !m[2]) throw bad('Photo must be a JPEG, PNG or WebP image');
  const input = Buffer.from(m[2], 'base64');
  if (input.length > MAX_INPUT_BYTES) throw bad('That photo is too large');
  if (!SIGNATURES[m[1]]?.(input)) throw bad('That file is not the image it claims to be');
  try {
    const img = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate().resize(p.side, p.side, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).grayscale(p.grey);
    for (const quality of [75, 65, 55, 45, 35]) {
      const { data, info } = await img.clone().webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true });
      if (data.length <= p.bytes) return { data, width: info.width, height: info.height, bytes: data.length };
    }
    throw bad('This photo has too much detail. Take it a little further away.');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw bad('That photo could not be read');
  }
}

type Labelled = { purchaseNumber?: string; adjustmentNumber?: string; billNumber?: string };
const OWNERS = {
  Purchase: { model: PurchaseModel, label: (d: Labelled) => d.purchaseNumber ?? '', module: 'purchases', missing: 'Purchase not found', flag: 'hasPhoto', profile: 'doc', what: 'a photo' },
  StockAdjustment: { model: AdjustmentModel, label: (d: Labelled) => d.adjustmentNumber ?? '', module: 'stock', missing: 'Adjustment not found', flag: 'hasPhoto', profile: 'doc', what: 'a photo' },
  Sale: { model: SaleModel, label: (d: Labelled) => d.billNumber ?? '', module: 'sales', missing: 'Bill not found', flag: 'hasRxPhoto', profile: 'rx', what: 'a prescription photo' },
} as const;

export async function attach(t: TenantContext, actor: Actor, ownerType: AttachmentOwner, ownerId: string, dataUrl: string, ip?: string) {
  const o = OWNERS[ownerType];
  const photo = await processDocument(dataUrl, o.profile);
  const id = new Types.ObjectId(ownerId);
  return inTransaction(async (session) => {
    const doc = await (o.model as typeof PurchaseModel).findOne({ shopId: t.shopId, _id: id }).select('purchaseNumber adjustmentNumber billNumber').session(session).lean<Labelled>();
    if (!doc) throw AppError.notFound(o.missing);
    await AttachmentModel.updateOne(
      { shopId: t.shopId, ownerType, ownerId: id },
      { $set: { mime: 'image/webp', ...photo, createdBy: new Types.ObjectId(actor.id), createdByName: actor.name } },
      { upsert: true, session },
    );
    await (o.model as typeof PurchaseModel).updateOne({ shopId: t.shopId, _id: id }, { $set: { [o.flag]: true } }, { session });
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: o.module, entityId: ownerId, entityName: o.label(doc), text: `${actor.name} attached ${o.what} to ${o.label(doc)}`, ip }, session);
    return { bytes: photo.bytes, width: photo.width, height: photo.height };
  });
}

export async function photoOf(t: TenantContext, ownerType: AttachmentOwner, ownerId: string) {
  const a = await AttachmentModel.findOne({ shopId: t.shopId, ownerType, ownerId: new Types.ObjectId(ownerId) }).lean();
  const b = bytesOf(a?.data);
  if (!a || !b) throw AppError.notFound('No photo yet');
  return { dataUrl: `data:${a.mime};base64,${b.toString('base64')}`, width: a.width, height: a.height, bytes: a.bytes, by: a.createdByName, at: a.createdAt };
}
