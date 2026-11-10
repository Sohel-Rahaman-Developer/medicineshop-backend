import { reportList } from '../reports/catalog';
import { MODULES, MODULE_NAMES, OPEN_REPORTS, REPORTS, type Feature } from './features';

/** What every plan always has; shown ticked and fixed in the admin checklist. */
export const ALWAYS = ['Billing (POS) and returns', 'Stock, expiry and racks', 'Purchases and suppliers', 'Udhaar', 'Expenses and day close', 'GST reports', 'H1 and X registers', 'Choosing a doctor on a bill'];

/** D113: the checklist, grouped; report names come from the report centre itself. */
export function featureCatalog() {
  const reports = new Map(reportList().map((r) => [r.key, r]));
  return {
    always: ALWAYS,
    modules: MODULES.map((key): { key: Feature; name: string } => ({ key, name: MODULE_NAMES[key] })),
    reports: REPORTS.map((key) => ({ key: `report:${key}` as Feature, name: reports.get(key)?.name ?? key, group: reports.get(key)?.group ?? 'Reports' })),
    openReports: OPEN_REPORTS.map((key) => reports.get(key)?.name ?? key),
  };
}
