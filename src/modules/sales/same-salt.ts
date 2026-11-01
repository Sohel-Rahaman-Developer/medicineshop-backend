import { Types } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { ProductModel } from '../products/product.model';
import { posSearch } from './sales.service';

// D110: medicines in stock with the same salt and strength, from the shop's own products — no AI. Salts compare as
// sets of words, so "Amoxycillin + Clavulanic Acid IP" and "clavulanic acid amoxycillin" are the same salt.

const SKIP = new Set(['ip', 'bp', 'usp', 'and', 'with', 'mg', 'mcg', 'ml', 'gm', 'iu', 'w', 'v']);
const saltWords = (s: string) => [...new Set(s.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter((w) => w.length > 1 && !SKIP.has(w)))].sort().join(' ');
const numbers = (s: string) => (s.match(/\d[\d.]*/g) ?? []).map((x) => Number(x.replace(/\.+$/, ''))).sort((a, b) => a - b).join(' ');

/** Up to six in-stock products with this salt (and these strength numbers, when given), as POS hits. */
export async function sameSaltIn(t: TenantContext, salt: string, strength: string, notId: string | null = null) {
  const want = saltWords(salt);
  if (want.length < 3) return [];
  const nums = numbers(strength);
  const rows = await ProductModel.find({ shopId: t.shopId, isActive: true, 'stock.sellable': { $gt: 0 }, saltKey: { $ne: '' } }).select('salt strength').limit(2000).lean();
  const ids = rows.filter((p) => String(p._id) !== notId && saltWords(p.salt) === want && (!nums || numbers(`${p.salt} ${p.strength}`) === nums)).map((p) => String(p._id));
  return ids.length ? (await posSearch(t, '', 50, ids.slice(0, 6))).items : [];
}

/** For a product out of stock at the counter: what else in stock has its salt and strength. */
export async function sameSaltOf(t: TenantContext, id: string) {
  const p = await ProductModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(id) }).select('salt strength').lean();
  if (!p) throw AppError.notFound('Product not found');
  return { salt: [p.salt, p.strength].filter(Boolean).join(' '), options: await sameSaltIn(t, p.salt, p.strength, id) };
}
