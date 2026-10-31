import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { needFeature, requirePermission, shopAuth, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { istDay } from '../../core/zod';
import { AppError } from '../../core/errors';
import { day, dayTime, pdfTable, rupees, sendFile, xlsx, type Column } from '../../core/export';
import { reportByKey, reportList, type Cell, type Col, type Params, type Row } from './catalog';
import { analytics } from './analytics.service';
import { gstinFamily } from '../branches/branches.service';
import { gstMonth } from './gst.service';
import * as pnl from './pnl.service';
import { ledgersXml, tallyMonth, vouchersXml } from './tally.service';
import { KINDS, NAMES, describe, register, type Filters, type Kind } from './registers.service';
import { SCHEDULE_TYPES } from '../products/product.model';
import { SALE_PAY_MODES } from '../sales/sale.model';
import { objectId } from '../../core/zod';

const rangeSchema = z
  .object({ from: istDay, to: istDay })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'From is after To', path: ['from'] })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 400 * 24 * 60 * 60 * 1000, { message: 'At most about a year at a time', path: ['to'] });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-10');
const monthSchema = z.object({ month }).strict();
const scope = z.enum(['shop', 'gstin']).optional();
const gstQuery = z.object({ month, scope }).strict();
const reportQuery = z.object({ from: istDay.optional(), to: istDay.optional(), month: month.optional(), format: z.enum(['xlsx', 'pdf']).optional(), scope }).strict();
const keyParams = z.object({ key: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict();

const IST = 5.5 * 60 * 60 * 1000;
const thisMonth = () => new Date(Date.now() + IST).toISOString().slice(0, 7);

/** Range reports need from + to (≤ about a year); month reports a month; the rest take nothing. */
function paramsOf(range: 'range' | 'none' | 'month', q: { from?: Date; to?: Date; month?: string }): Params {
  if (range === 'range') {
    if (!q.from || !q.to) throw AppError.validation('Choose a date range', [{ field: 'query.from', message: 'From and To are needed' }]);
    if (q.from > q.to || q.to.getTime() - q.from.getTime() > 400 * 24 * 60 * 60 * 1000) throw AppError.validation('Choose a range of at most about a year', [{ field: 'query.to', message: 'Range too long or reversed' }]);
  }
  return { from: q.from ?? new Date(0), to: q.to ?? new Date(), month: q.month ?? thisMonth() };
}

const cellText = (col: Col, v: Cell | undefined) => {
  if (v === null || v === undefined || v === '') return '';
  if (col.kind === 'money') return rupees(Number(v));
  if (col.kind === 'date') return /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? day(new Date(String(v))) : String(v);
  if (col.kind === 'datetime') return dayTime(new Date(String(v)));
  if (col.kind === 'pct') return Number(v).toFixed(2);
  return String(v);
};
/** Excel keeps numbers as numbers (₹ in rupees) so the CA can add them up. */
const cellValue = (col: Col, v: Cell | undefined): string | number => {
  if (v === null || v === undefined) return '';
  if (col.kind === 'money') return Number(v) / 100;
  if (col.kind === 'num' || col.kind === 'pct') return v;
  return cellText(col, v);
};

// PLAN §20 / sandbox money.js: P&L and the day book need reports:view (the same gate as seeing cost).
export const reportsRouter = Router();
reportsRouter.use(shopAuth, requirePermission('reports', 'view'));

// D87: GST stays in every plan (the CA needs it); P&L, the report centre and analytics are Pro.
const pnlPlan = needFeature('pnl');
const gstKeys = new Set(['gst-sales', 'gst-purchase']);

/** v1.25.3: "all shops on this GSTIN" — the owner's shops that share it; anyone else only ever sees this shop. */
async function together(req: Request, want: 'shop' | 'gstin' | undefined) {
  const fam = await gstinFamily(tenantOf(req), req.auth?.userId ?? '');
  if (want === 'gstin' && !fam.shops.length) throw AppError.forbidden('Only the owner of two or more shops on this GSTIN sees them together');
  return { fam, shops: want === 'gstin' ? fam.shops.map((s) => s.id) : undefined };
}
const reportPlan: RequestHandler = (req, res, next) => {
  if (gstKeys.has((req.params as { key?: string }).key ?? '')) {
    next();
    return;
  }
  needFeature('reports')(req, res, next);
};

reportsRouter.get(
  '/pnl',
  pnlPlan,
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from: Date; to: Date };
    fetched(res, await pnl.pnl(tenantOf(req), q.from, q.to));
  }),
);

reportsRouter.get('/pnl/months', pnlPlan, asyncHandler(async (req: Request, res: Response) => { fetched(res, await pnl.months(tenantOf(req))); }));

reportsRouter.get(
  '/daybook',
  pnlPlan,
  validate({ query: monthSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await pnl.daybook(tenantOf(req), (req.query as { month: string }).month));
  }),
);

// S61 report centre: the list, a report (first 300 rows on screen) and its Excel / PDF (reports:export, all rows).
reportsRouter.get('/catalog', needFeature('reports'), (_req: Request, res: Response) => { fetched(res, reportList()); });

reportsRouter.get(
  '/r/:key',
  validate({ params: keyParams, query: reportQuery }),
  reportPlan,
  asyncHandler(async (req: Request, res: Response) => {
    const r = reportByKey((req.params as { key: string }).key);
    if (!r) throw AppError.notFound('Report not found');
    const q = req.query as unknown as { from?: Date; to?: Date; month?: string };
    const rows = await r.rows(tenantOf(req), paramsOf(r.range, q));
    const total = rows.at(-1)?.__total ? rows.at(-1) : null;
    const body = total ? rows.slice(0, -1) : rows;
    fetched(res, { key: r.key, name: r.name, group: r.group, range: r.range, note: r.note ?? null, cols: r.cols, rows: body.slice(0, 300), total: total ?? null, count: body.length });
  }),
);

reportsRouter.get(
  '/r/:key/export',
  requirePermission('reports', 'export'),
  validate({ params: keyParams, query: reportQuery }),
  reportPlan,
  asyncHandler(async (req: Request, res: Response) => {
    const r = reportByKey((req.params as { key: string }).key);
    if (!r) throw AppError.notFound('Report not found');
    const q = req.query as unknown as { from?: Date; to?: Date; month?: string; format?: 'xlsx' | 'pdf'; scope?: 'shop' | 'gstin' };
    if (q.scope === 'gstin' && !gstKeys.has(r.key)) throw AppError.validation('Only the GST reports add up shops', [{ field: 'query.scope', message: 'GST reports only' }]);
    const all = await together(req, q.scope);
    const p = { ...paramsOf(r.range, q), shops: all.shops };
    const rows = await r.rows(tenantOf(req), p);
    const span = r.range === 'none' ? `As of ${day(new Date())}` : r.range === 'month' ? p.month : `${day(p.from)} – ${day(p.to)}`;
    const sub = all.shops ? `${span} · GSTIN ${all.fam.gstin}, ${String(all.shops.length)} shops` : span;
    if (q.format === 'pdf') {
      const columns: Column<Row>[] = r.cols.map((c) => ({ label: c.label, num: c.kind === 'money' || c.kind === 'num' || c.kind === 'pct', get: (row) => cellText(c, row[c.key]) }));
      sendFile(res, await pdfTable({ shopId: tenantOf(req).shopId, title: r.name, sub, columns, rows, landscape: r.cols.length > 5 }), `${r.name} ${sub}`, 'pdf');
      return;
    }
    const columns: Column<Row>[] = r.cols.map((c) => ({ label: c.kind === 'money' ? `${c.label} (₹)` : c.label, get: (row) => cellValue(c, row[c.key]) }));
    sendFile(res, await xlsx(columns, rows), `${r.name} ${sub}`, 'xlsx');
  }),
);

// S62 GST: a month for the CA, and the same as a 3-sheet workbook.
reportsRouter.get(
  '/gst',
  validate({ query: gstQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as { month: string; scope?: 'shop' | 'gstin' };
    const all = await together(req, q.scope);
    const shared = all.fam.shops.length ? { gstin: all.fam.gstin, shops: all.fam.shops.map((s) => ({ id: String(s.id), name: s.name })) } : null;
    fetched(res, { ...(await gstMonth(tenantOf(req), q.month, new Date(), all.shops)), scope: all.shops ? 'gstin' : 'shop', shared });
  }),
);

// Registers: any medicine's sales, stock and purchases with every filter the records allow; a list is "a,b,c".
const csv = (allowed?: readonly string[]) =>
  z
    .string()
    .max(600)
    .optional()
    .transform((v) => (v ? [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 30) : []))
    .refine((xs) => !allowed || xs.every((x) => allowed.includes(x)), { message: 'Unknown value' });
const words = z.string().trim().max(60).optional();
const rupeesPaise = z.coerce.number().int().min(0).max(1_000_000_000).optional();
const registerQuery = z
  .object({ from: istDay.optional(), to: istDay.optional(), schedule: csv(SCHEDULE_TYPES), category: csv(), pay: csv(SALE_PAY_MODES), q: words, party: words, doctor: words, staff: objectId.optional(), min: rupeesPaise, max: rupeesPaise, expiry: z.enum(['all', 'expired', 'soon']).optional(), format: z.enum(['xlsx', 'pdf']).optional() })
  .strict()
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, { message: 'From is more than To', path: ['min'] });
const kindParams = z.object({ kind: z.enum(KINDS) }).strict();
type RegisterQuery = Filters & { format?: 'xlsx' | 'pdf' };

function filtersOf(kind: Kind, q: RegisterQuery): Filters {
  if (kind !== 'stock') paramsOf('range', q);
  return { from: q.from, to: q.to, schedule: q.schedule, category: q.category, q: q.q, party: q.party, doctor: q.doctor, pay: q.pay, staff: q.staff, min: q.min, max: q.max, expiry: q.expiry };
}

reportsRouter.get(
  '/registers/:kind',
  needFeature('reports'),
  validate({ params: kindParams, query: registerQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const kind = (req.params as { kind: Kind }).kind;
    fetched(res, await register(tenantOf(req), kind, filtersOf(kind, req.query as unknown as RegisterQuery)));
  }),
);

reportsRouter.get(
  '/registers/:kind/export',
  requirePermission('reports', 'export'),
  needFeature('reports'),
  validate({ params: kindParams, query: registerQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const kind = (req.params as { kind: Kind }).kind;
    const q = req.query as unknown as RegisterQuery;
    const f = filtersOf(kind, q);
    const r = await register(tenantOf(req), kind, f, true);
    const span = kind === 'stock' ? `As of ${day(new Date())}` : `${day(f.from ?? new Date())} – ${day(f.to ?? new Date())}`;
    const sub = describe(kind, f, span);
    const t = r.totals;
    if (q.format === 'pdf') {
      const columns: Column<Row>[] = r.cols.map((c) => ({ label: c.label, num: c.kind === 'money' || c.kind === 'num', get: (row) => cellText(c, row[c.key]) }));
      const summary: [string, string][] | undefined = t ? [[`${String(t.bills)} ${t.bills === 1 ? 'bill' : 'bills'}, their full amounts`, rupees(t.billTotal)], ['These lines', rupees(t.lineTotal)]] : undefined;
      sendFile(res, await pdfTable({ shopId: tenantOf(req).shopId, title: NAMES[kind], sub, columns, rows: r.rows, landscape: true, summary }), `${NAMES[kind]} ${sub}`, 'pdf');
      return;
    }
    const columns: Column<Row>[] = r.cols.map((c) => ({ label: c.kind === 'money' ? `${c.label} (₹)` : c.label, get: (row) => cellValue(c, row[c.key]) }));
    const totalRows: Row[] = t ? [{ bill: 'Total of these lines', amount: t.lineTotal }, { bill: `${String(t.bills)} ${t.bills === 1 ? 'bill' : 'bills'}, their full amounts`, amount: t.billTotal }] : [];
    sendFile(res, await xlsx(columns, [...r.rows, ...totalRows]), `${NAMES[kind]} ${sub}`, 'xlsx');
  }),
);

// Tally: a month's vouchers — what goes in (on screen), then the ledgers file and the entries file to import.
const tallyFile = z.object({ month, part: z.enum(['ledgers', 'entries']) }).strict();
reportsRouter.get(
  '/tally',
  needFeature('tally'),
  validate({ query: monthSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const r = await tallyMonth(tenantOf(req), (req.query as { month: string }).month);
    fetched(res, { month: r.month, from: r.from, to: r.to, vouchers: r.vouchers.length, counts: r.counts, ledgers: r.ledgers.map((l) => ({ name: l.name, group: l.group })) });
  }),
);

reportsRouter.get(
  '/tally/file',
  requirePermission('reports', 'export'),
  needFeature('tally'),
  validate({ query: tallyFile }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as { month: string; part: 'ledgers' | 'entries' };
    const r = await tallyMonth(tenantOf(req), q.month);
    const xml = q.part === 'ledgers' ? ledgersXml(r.ledgers) : vouchersXml(r.vouchers);
    sendFile(res, Buffer.from(xml, 'utf8'), `Tally ${q.part === 'ledgers' ? '1 ledgers' : '2 entries'} ${q.month}`, 'xml');
  }),
);

const analyticsQuery = z
  .object({ tab: z.enum(['sales', 'stock', 'customers', 'suppliers']), from: istDay, to: istDay })
  .strict()
  .refine((v) => v.from <= v.to && v.to.getTime() - v.from.getTime() <= 400 * 24 * 60 * 60 * 1000, { message: 'Choose a range of at most about a year', path: ['to'] });

// S60 analytics: one tab at a time, every chart on the topbar range.
reportsRouter.get(
  '/analytics',
  needFeature('analytics'),
  validate({ query: analyticsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { tab: 'sales' | 'stock' | 'customers' | 'suppliers'; from: Date; to: Date };
    if (!req.auth) throw AppError.unauthenticated();
    fetched(res, await analytics(tenantOf(req), req.auth.userId, q.tab, q.from, q.to));
  }),
);
