// D87: what a plan opens beyond the daily work (billing, stock, buying, udhaar, expenses, GST stay in every plan).
export const FEATURES = ['analytics', 'reports', 'pnl', 'loyalty', 'doctors', 'orders', 'roles', 'ask', 'ai', 'clinic', 'brief', 'refills', 'labels', 'tally'] as const;
/** The modules that existed before a plan remembered which ones it knew (D87). */
export const D87_FEATURES: readonly string[] = ['analytics', 'reports', 'pnl', 'loyalty', 'doctors', 'orders', 'roles', 'ask', 'ai'];
export type Feature = (typeof FEATURES)[number];
export const TIERS = ['basic', 'pro'] as const;
export type Tier = (typeof TIERS)[number];

export const FEATURE_NAMES: Record<Feature, string> = {
  analytics: 'Analytics',
  reports: 'Reports and Excel',
  pnl: 'Profit & Loss and day book',
  loyalty: 'Loyalty points',
  doctors: 'Doctors list',
  orders: 'Customer orders',
  roles: 'Own roles',
  ask: 'Ask your shop',
  ai: 'AI answers and AI bill reading',
  clinic: 'Doctor appointments',
  brief: 'Morning brief',
  refills: 'Refills due',
  labels: 'Barcode labels',
  tally: 'Tally export',
};

export const allFeatures = (): Feature[] => [...FEATURES];
