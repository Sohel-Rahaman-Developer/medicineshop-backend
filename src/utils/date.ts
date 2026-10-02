const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "EXP 03/2031" is valid to the last second of that month in India (PLAN §26). */
export function monthEndIST(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0, 23, 59, 59) - IST_OFFSET_MS);
}

/** The IST calendar day as "YYMMDD" — the lot number of a non-medicine bought without a batch (D59). */
export function istYmd(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return `${String(ist.getUTCFullYear() % 100).padStart(2, '0')}${String(ist.getUTCMonth() + 1).padStart(2, '0')}${String(ist.getUTCDate()).padStart(2, '0')}`;
}

/** The IST calendar month of an instant, as "YYYY-MM". */
export function istMonth(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 2026" in IST, for messages. */
export function monthLabel(at: Date): string {
  if (at.getUTCFullYear() >= 9999) return 'no expiry';
  const [y = '', m = '1'] = istMonth(at).split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${y}`;
}

/** The IST calendar day of an instant, as "YYYY-MM-DD". */
export function istIsoDay(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return `${String(ist.getUTCFullYear())}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

/** 00:00 IST of the day an instant falls in. */
export const istDayStart = (at: Date) => new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS);

/** "HH:MM" on the IST clock — shop settings keep digest times this way. */
export function istClock(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
}
