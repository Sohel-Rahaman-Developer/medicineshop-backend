const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "EXP 03/2031" is valid to the last second of that month in India (PLAN §26). */
export function monthEndIST(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0, 23, 59, 59) - IST_OFFSET_MS);
}

/** The IST calendar month of an instant, as "YYYY-MM". */
export function istMonth(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 2026" in IST, for messages. */
export function monthLabel(at: Date): string {
  const [y = '', m = '1'] = istMonth(at).split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${y}`;
}
