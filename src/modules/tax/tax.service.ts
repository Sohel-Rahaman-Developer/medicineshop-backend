import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { audit } from '../audit/audit.model';
import { ProductModel } from '../products/product.model';
import { ShopModel } from '../shops/shop.model';
import type { Actor } from '../user/actor';
import type { TaxSettingsInput } from './tax.validation';

export interface TaxRate {
  name: string;
  rate: number;
}

/** A new shop's list — the old fixed slabs, so nothing changes until the owner edits it (D62). */
export const DEFAULT_TAX_RATES: TaxRate[] = [
  { name: 'No tax', rate: 0 },
  { name: 'GST 5%', rate: 5 },
  { name: 'GST 12%', rate: 12 },
  { name: 'GST 18%', rate: 18 },
  { name: 'GST 28%', rate: 28 },
  { name: 'GST 40%', rate: 40 },
];

const pct = (r: number) => `${String(r)}%`;

export async function ratesOf(t: TenantContext, session?: ClientSession): Promise<TaxRate[]> {
  const shop = await ShopModel.findOne({ _id: t.shopId }).select('settings.tax.rates').session(session ?? null).lean();
  const rates = shop?.settings.tax?.rates;
  return rates?.length ? rates.map((r) => ({ name: r.name, rate: r.rate })).sort((a, b) => a.rate - b.rate) : DEFAULT_TAX_RATES;
}

/** Products only take a rate from the shop's own list — the shop decides which tax applies, never the app. */
export async function assertRate(t: TenantContext, rate: number, field = 'body.gstRate') {
  if ((await ratesOf(t)).some((r) => r.rate === rate)) return;
  const message = `GST ${pct(rate)} is not in your tax list — add it in Settings → Tax`;
  throw AppError.validation(message, [{ field, message }]);
}

export async function taxSettings(t: TenantContext) {
  const [shop, rates, used] = await Promise.all([
    ShopModel.findOne({ _id: t.shopId }).select('settings.tax').lean(),
    ratesOf(t),
    ProductModel.aggregate<{ _id: number; n: number }>([{ $match: { shopId: t.shopId } }, { $group: { _id: '$gstRate', n: { $sum: 1 } } }]),
  ]);
  const count = new Map(used.map((u) => [u._id, u.n]));
  return {
    rates: rates.map((r) => ({ ...r, products: count.get(r.rate) ?? 0 })),
    defaultGstRate: shop?.settings.tax?.defaultGstRate ?? 12,
    showHsnOnBill: shop?.settings.tax?.showHsnOnBill ?? true,
  };
}

export async function saveTaxSettings(t: TenantContext, actor: Actor, input: TaxSettingsInput, ip?: string) {
  const before = await taxSettings(t);
  const rates = [...input.rates].sort((a, b) => a.rate - b.rate);
  const gone = before.rates.filter((r) => !rates.some((x) => x.rate === r.rate));
  const busy = gone.filter((r) => r.products > 0);
  if (busy.length) {
    const what = busy.map((r) => `${r.name} is on ${String(r.products)} product${r.products === 1 ? '' : 's'}`).join(', ');
    throw AppError.conflict(`${what} — move them to another rate first`, { reason: 'TAX_RATE_IN_USE' });
  }
  await ShopModel.updateOne({ _id: t.shopId }, { $set: { 'settings.tax.rates': rates, 'settings.tax.defaultGstRate': input.defaultGstRate, 'settings.tax.showHsnOnBill': input.showHsnOnBill } });
  const what = [
    ...rates.filter((r) => !before.rates.some((x) => x.rate === r.rate)).map((r) => `added ${r.name} (${pct(r.rate)})`),
    ...gone.map((r) => `removed ${r.name} (${pct(r.rate)})`),
    ...rates.flatMap((r) => {
      const old = before.rates.find((x) => x.rate === r.rate);
      return old && old.name !== r.name ? [`renamed ${old.name} → ${r.name}`] : [];
    }),
    before.defaultGstRate !== input.defaultGstRate ? `default ${pct(before.defaultGstRate)} → ${pct(input.defaultGstRate)}` : '',
    before.showHsnOnBill !== input.showHsnOnBill ? (input.showHsnOnBill ? 'HSN on the bill on' : 'HSN on the bill off') : '',
  ].filter(Boolean);
  if (what.length) {
    const strip = (s: typeof before) => ({ rates: s.rates.map((r) => ({ name: r.name, rate: r.rate })), defaultGstRate: s.defaultGstRate, showHsnOnBill: s.showHsnOnBill });
    await audit({ shopId: t.shopId, userId: actor.id, userName: actor.name, action: 'update', module: 'settings', entityId: String(t.shopId), entityName: 'Tax rates', text: `${actor.name} changed tax: ${what.join(' · ')}`, changes: { before: strip(before), after: { rates, defaultGstRate: input.defaultGstRate, showHsnOnBill: input.showHsnOnBill } }, ip });
  }
  return taxSettings(t);
}
