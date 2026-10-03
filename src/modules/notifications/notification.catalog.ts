// PLAN §17 types: the group (screen tab), default channels, and which ones can't be switched off.

export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Group = 'stock' | 'expiry' | 'money' | 'system';
export type Channel = 'inapp' | 'email';

interface TypeInfo {
  label: string;
  group: Group;
  channels: Channel[];
  /** Critical types stay on whatever the person chose (PLAN §17). */
  locked?: boolean;
}

export const TYPES = {
  EXPIRED: { label: 'Expired stock', group: 'expiry', channels: ['inapp', 'email'], locked: true },
  // The shop picks its own alert days (settings.inventory.expiryAlertDays); nearest window first.
  EXPIRY_SOON: { label: 'Expiring soon (nearest alert days)', group: 'expiry', channels: ['inapp', 'email'] },
  EXPIRY_NEXT: { label: 'Expiring next (second alert days)', group: 'expiry', channels: ['inapp', 'email'] },
  EXPIRY_AHEAD: { label: 'Expiring later (further alert days)', group: 'expiry', channels: ['inapp'] },
  STOCK_OUT: { label: 'Out of stock', group: 'stock', channels: ['inapp', 'email'] },
  STOCK_LOW: { label: 'Low stock', group: 'stock', channels: ['inapp', 'email'] },
  ORDER_READY: { label: 'Customer orders', group: 'stock', channels: ['inapp'] },
  SUPPLIER_DUE: { label: 'Supplier payments due', group: 'money', channels: ['inapp', 'email'] },
  UDHAAR_OVERDUE: { label: 'Old udhaar', group: 'money', channels: ['inapp'] },
  CASH_SHORT: { label: 'Cash drawer', group: 'money', channels: ['inapp', 'email'] },
  LARGE_DISCOUNT: { label: 'Discount above the limit', group: 'money', channels: ['inapp'] },
  DAILY_SUMMARY: { label: 'Daily summary', group: 'system', channels: ['inapp', 'email'] },
  LOYALTY_SETUP: { label: 'Loyalty set-up', group: 'system', channels: ['inapp'] },
  LOYALTY_TIER_UP: { label: 'Customer tier up', group: 'system', channels: ['inapp'] },
  DL_EXPIRY: { label: 'Drug licence', group: 'system', channels: ['inapp', 'email'] },
  SUBSCRIPTION_EXPIRING: { label: 'Plan ending', group: 'system', channels: ['inapp', 'email'] },
  SUBSCRIPTION_EXPIRED: { label: 'Plan ended', group: 'system', channels: ['inapp', 'email'], locked: true },
  // The owner must see a support request; it can't be switched off (D15).
  SUPPORT_ACCESS: { label: 'MedShop support access', group: 'system', channels: ['inapp'], locked: true },
} as const satisfies Record<string, TypeInfo>;

export type NotificationType = keyof typeof TYPES;
export const NOTIFICATION_TYPES = Object.keys(TYPES) as NotificationType[];

export const typeInfo = (t: NotificationType): TypeInfo => TYPES[t];
