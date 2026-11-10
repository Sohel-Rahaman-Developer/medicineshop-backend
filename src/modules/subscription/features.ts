// D87 + D113: what a plan opens beyond the daily work. The daily work never locks: billing, stock, buying, udhaar,
// expenses, day close, GST, the H1 / X registers and choosing a doctor on a bill (the law needs them in every shop).
// This file is the only list: the admin checklist, the shop app and the website read it through GET /plans/features.

export const MODULES = ['analytics', 'pnl', 'loyalty', 'doctors', 'orders', 'roles', 'ask', 'ai', 'clinic', 'brief', 'refills', 'labels', 'tally', 'registers', 'bill-import', 'payroll'] as const;
/** Report-centre reports a plan may lock, one by one; P&L and the day book follow `pnl`. */
export const REPORTS = ['sales-register', 'sales-summary', 'product-sales', 'batch-sales', 'staff', 'discounts', 'stock-on-hand', 'valuation', 'expiry', 'expired', 'dead', 'movements', 'purchase-register', 'supplier-ledger', 'supplier-outstanding', 'customer-outstanding', 'top-customers', 'loyalty', 'expenses'] as const;
/** Reports the law needs in every shop: never locked. */
export const OPEN_REPORTS = ['gst-sales', 'gst-purchase', 'h1', 'x'] as const;

export type PlanModule = (typeof MODULES)[number];
export type ReportFeature = `report:${(typeof REPORTS)[number]}`;
export type Feature = PlanModule | ReportFeature;

const reportFeature = (key: (typeof REPORTS)[number]): ReportFeature => `report:${key}`;
export const FEATURES: readonly Feature[] = [...MODULES, ...REPORTS.map(reportFeature)];
const KNOWN = new Set<string>(FEATURES);
export const isFeature = (v: string): v is Feature => KNOWN.has(v);

/** The modules that existed before a plan remembered which ones it knew (D87). */
export const D87_FEATURES: readonly string[] = ['analytics', 'reports', 'pnl', 'loyalty', 'doctors', 'orders', 'roles', 'ask', 'ai'];
/** Before D113 one `reports` switch opened the whole report centre and the registers. */
export const REPORTS_SPLIT: readonly Feature[] = ['registers', ...REPORTS.map(reportFeature)];

export const TIERS = ['basic', 'pro'] as const;
export type Tier = (typeof TIERS)[number];

/** D113 Basic: AI reading (no chat) and the everyday reports; the admin changes it any time. */
export const BASIC_FEATURES: readonly Feature[] = ['ai', ...(['sales-register', 'sales-summary', 'stock-on-hand', 'expiry', 'expired', 'purchase-register', 'supplier-outstanding', 'customer-outstanding', 'expenses'] as const).map(reportFeature)];

export const MODULE_NAMES: Record<PlanModule, string> = {
  analytics: 'Analytics',
  pnl: 'Profit & Loss and day book',
  loyalty: 'Loyalty points',
  doctors: 'Doctors list',
  orders: 'Customer orders',
  roles: 'Own roles',
  ask: 'Ask your shop (chat)',
  ai: 'AI reading: supplier bills, prescriptions, salts',
  clinic: 'Doctor appointments',
  brief: 'Morning brief',
  refills: 'Refills due',
  labels: 'Barcode labels',
  tally: 'Tally export',
  registers: 'Sales, stock and purchase registers',
  'bill-import': 'Stock in from a supplier bill file (PDF, Word, Excel)',
  payroll: 'Staff pay: attendance, advances, salary and PF',
};

/** A report's lock: its own feature, `pnl` for P&L and the day book, none for the law's reports.
 * A report missing from REPORTS stays behind `pnl` (fail closed); the unit test keeps the lists equal. */
export function featureOfReport(key: string): Feature | null {
  if ((OPEN_REPORTS as readonly string[]).includes(key)) return null;
  const f = `report:${key}`;
  return isFeature(f) ? f : 'pnl';
}

export const allFeatures = (): Feature[] => [...FEATURES];
