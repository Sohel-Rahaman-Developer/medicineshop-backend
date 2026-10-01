const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Indian financial year of an instant, by the IST calendar date: 2026-04-01 → "2026-27". */
export function fyOf(at: Date, startMonth = 4): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() + 1 >= startMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
