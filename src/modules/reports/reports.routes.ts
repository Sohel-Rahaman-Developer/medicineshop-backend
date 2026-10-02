import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler';
import { requireAuth } from '../../core/middleware/require-auth';
import { requirePermission, tenant, tenantOf } from '../../core/middleware/tenant';
import { validate } from '../../core/middleware/validate';
import { fetched } from '../../core/response';
import { istDay } from '../../core/zod';
import { AppError } from '../../core/errors';
import { day, dayTime, pdfTable, rupees, sendFile, xlsx, type Column } from '../../core/export';
import { reportByKey, reportList, type Cell, type Col, type Params, type Row } from './catalog';
import { gstMonth } from './gst.service';
import * as pnl from './pnl.service';

const rangeSchema = z
  .object({ from: istDay, to: istDay })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'From is after To', path: ['from'] })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 400 * 24 * 60 * 60 * 1000, { message: 'At most about a year at a time', path: ['to'] });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-10');
const monthSchema = z.object({ month }).strict();
const reportQuery = z.object({ from: istDay.optional(), to: istDay.optional(), month: month.optional(), format: z.enum(['xlsx', 'pdf']).optional() }).strict();
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
reportsRouter.use(requireAuth, tenant, requirePermission('reports', 'view'));

reportsRouter.get(
  '/pnl',
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { from: Date; to: Date };
    fetched(res, await pnl.pnl(tenantOf(req), q.from, q.to));
  }),
);

reportsRouter.get('/pnl/months', asyncHandler(async (req: Request, res: Response) => { fetched(res, await pnl.months(tenantOf(req))); }));

reportsRouter.get(
  '/daybook',
  validate({ query: monthSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await pnl.daybook(tenantOf(req), (req.query as { month: string }).month));
  }),
);

// S61 report centre: the list, a report (first 300 rows on screen) and its Excel / PDF (reports:export, all rows).
reportsRouter.get('/catalog', (_req: Request, res: Response) => { fetched(res, reportList()); });

reportsRouter.get(
  '/r/:key',
  validate({ params: keyParams, query: reportQuery }),
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
  asyncHandler(async (req: Request, res: Response) => {
    const r = reportByKey((req.params as { key: string }).key);
    if (!r) throw AppError.notFound('Report not found');
    const q = req.query as unknown as { from?: Date; to?: Date; month?: string; format?: 'xlsx' | 'pdf' };
    const p = paramsOf(r.range, q);
    const rows = await r.rows(tenantOf(req), p);
    const sub = r.range === 'none' ? `As of ${day(new Date())}` : r.range === 'month' ? p.month : `${day(p.from)} – ${day(p.to)}`;
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
  validate({ query: monthSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    fetched(res, await gstMonth(tenantOf(req), (req.query as { month: string }).month));
  }),
);
