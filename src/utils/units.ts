// Same copy lives in frontend/src/lib/units.ts (PLAN §10). Stock is always kept in the base unit.
export const UNIT_TYPES = ['COUNT', 'VOLUME', 'WEIGHT'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const UNITS: Record<UnitType, readonly string[]> = {
  COUNT: ['TABLET', 'CAPSULE', 'PIECE', 'STRIP', 'BOX', 'VIAL', 'TUBE', 'BOTTLE', 'PACKET', 'PAIR', 'BAR', 'CAN', 'JAR', 'SACHET', 'PACK', 'ROLL', 'KIT', 'CASE'],
  VOLUME: ['ML', 'LITRE'],
  WEIGHT: ['GM', 'KG'],
};
export const ALL_UNITS = [...UNITS.COUNT, ...UNITS.VOLUME, ...UNITS.WEIGHT];

export interface Units {
  type: UnitType;
  base: string;
  sale: string;
  purchase: string;
  conversions: Record<string, number>;
  allowLooseSale: boolean;
}

/** How a person describes packs: 1 sale unit = salePack base units, 1 purchase unit = purchasePack sale units. */
export interface UnitsInput {
  type: UnitType;
  base: string;
  sale: string;
  salePack: number;
  purchase: string;
  purchasePack: number;
  allowLooseSale: boolean;
}

/** Returns an error message, or null when the setup makes sense. */
export function unitsProblem(u: UnitsInput): string | null {
  const list = UNITS[u.type];
  if (!list.includes(u.base) || !list.includes(u.sale) || !list.includes(u.purchase)) return `Pick ${u.type.toLowerCase()} units only`;
  if (u.sale === u.base && u.salePack !== 1) return `1 ${u.sale} is 1 ${u.base} when they are the same unit`;
  if (u.sale !== u.base && u.salePack < 2) return `1 ${u.sale} must hold at least 2 ${u.base}`;
  if (u.purchase === u.sale && u.purchasePack !== 1) return `1 ${u.purchase} is 1 ${u.sale} when they are the same unit`;
  if (u.purchase !== u.sale && u.purchase === u.base) return 'The purchase unit can’t be smaller than the sale unit';
  if (u.purchase !== u.sale && u.purchasePack < 2) return `1 ${u.purchase} must hold at least 2 ${u.sale}`;
  return null;
}

export function toUnits(u: UnitsInput): Units {
  const conversions: Record<string, number> = { [u.base]: 1 };
  conversions[u.sale] = u.salePack;
  conversions[u.purchase] = u.purchase === u.sale ? u.salePack : u.salePack * u.purchasePack;
  return { type: u.type, base: u.base, sale: u.sale, purchase: u.purchase, conversions, allowLooseSale: u.allowLooseSale };
}

export function conv(u: Units, unit: string): number {
  return u.conversions[unit] ?? 1;
}

export const salePack = (u: Units) => conv(u, u.sale);
export const purchasePack = (u: Units) => conv(u, u.purchase) / salePack(u);

export const toBase = (qty: number, unit: string, u: Units) => Math.round(qty * conv(u, unit));
export const saleUnits = (base: number, u: Units) => Math.floor(base / salePack(u));

/** 326 TABLET with 15 per STRIP → "21 STRIP + 11 TABLET". */
export function fromBase(base: number, u: Units): string {
  const pack = salePack(u);
  if (base === 0) return `0 ${u.sale}`;
  const sign = base < 0 ? '−' : '';
  const abs = Math.abs(base);
  if (pack === 1) return `${sign}${abs} ${u.base}`;
  const whole = Math.floor(abs / pack);
  const loose = abs % pack;
  const parts = [whole ? `${whole} ${u.sale}` : '', loose ? `${loose} ${u.base}` : ''].filter(Boolean);
  return sign + parts.join(' + ');
}

/** A bill's pack column → units: "10×15" / "10*15T" = 10 strips of 15, "15 TAB" = strip of 15, "200 ML" / "75GM" = size only. Same copy in frontend/src/lib/units.ts. */
export function readPack(raw: string): { salePack?: number; purchasePack?: number; size?: string } | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;
  let m = /^(\d{1,4}) ?[X×*] ?(\d{1,4}) ?(TABS|TAB|T|CAPS|CAP|C|S)?$/.exec(s) ?? /^(\d{1,4}) (\d{1,4})$/.exec(s);
  if (m) return { purchasePack: Number(m[1]), salePack: Number(m[2]) };
  m = /^(\d{1,4}) ?(TABS|TAB|T|CAPS|CAP|C|S)?$/.exec(s);
  if (m) return { salePack: Number(m[1]) };
  m = /^(\d+\.\d+|\d+) ?(ML|GM|G|KG|L|LTR|MG|MCG)$/.exec(s);
  if (m) return { size: `${m[1] ?? ''} ${(m[2] === 'G' ? 'GM' : (m[2] ?? '')).toLowerCase()}` };
  return null;
}
