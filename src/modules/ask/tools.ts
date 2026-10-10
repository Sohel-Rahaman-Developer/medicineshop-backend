import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { TenantContext } from '../../core/middleware/tenant';
import { dayLabel } from '../../utils/date';
import { inr } from '../../utils/money';
import * as C from './cards';
import * as F from './facts';

// D81: what the AI may look up — the same facts as the free cards, read-only. The shop and the asker come from the
// session (never from the model); the model only picks a tool and its words.

const PERIODS = ['today', 'yesterday', 'week', 'month', 'last_month', 'days'] as const;
const periodInput = z.object({ period: z.enum(PERIODS), days: z.number().int().min(1).max(365).optional().describe('Only with period "days"') }).strict();
const nameInput = z.object({ name: z.string().trim().min(1).max(60).describe('In English letters, e.g. "dolo 650" or "paracetamol"') }).strict();
const maybeName = z.object({ name: z.string().trim().min(1).max(60).optional().describe('Leave out for everyone') }).strict();
const daysInput = z.object({ days: z.number().int().min(1).max(365) }).strict();
const none = z.object({}).strict();

const toPeriod = (i: z.infer<typeof periodInput>): F.Period => (i.period === 'days' ? { key: 'days', n: i.days ?? 7 } : { key: i.period });

export interface Ctx {
  t: TenantContext;
  userId: string;
  now: Date;
}

interface Tool<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  run: (c: Ctx, i: z.infer<S>) => Promise<{ data: unknown; href?: string }>;
}
const tool = <S extends z.ZodType>(t: Tool<S>) => t as unknown as Tool<z.ZodType>;
const en = 'en' as const;

export const TOOLS = [
  tool({ name: 'sales', description: 'Bills, net sale (billed less returns), average bill, returns and cancelled bills for a period.', input: periodInput, run: async (c, i) => { const d = await F.sales(c.t, c.userId, toPeriod(i), c.now); return { data: d, href: C.salesCard(d, en).href }; } }),
  tool({ name: 'profit', description: 'Gross profit, sales before tax, cost of goods and margin for a period.', input: periodInput, run: async (c, i) => { const d = await F.profit(c.t, c.userId, toPeriod(i), c.now); return { data: d.profit, href: C.profitCard(d, en).href }; } }),
  tool({ name: 'top_items', description: 'The 10 products that sold the most (by amount) in a period.', input: periodInput, run: async (c, i) => { const d = await F.topItems(c.t, c.userId, toPeriod(i), c.now); return { data: d, href: C.topCard(d, en).href }; } }),
  tool({ name: 'product_stock', description: 'Stock of one product by its name, salt or company: quantity, next expiry, batches with rack.', input: nameInput, run: async (c, i) => { const d = await F.stockOf(c.t, i.name); return { data: d, href: C.stockCard(d, en).href }; } }),
  tool({ name: 'stock_summary', description: 'The whole stock: products, how many are low or out, value at MRP.', input: none, run: async (c) => { const d = await F.stockSummary(c.t); return { data: d, href: C.stockSummaryCard(d, en).href }; } }),
  tool({ name: 'low_stock', description: 'Products that are low or out of stock (to reorder).', input: none, run: async (c) => { const d = await F.lowStock(c.t); return { data: d, href: C.lowCard(d, en).href }; } }),
  tool({ name: 'expiring', description: 'Batches that expire within the next N days, soonest first.', input: daysInput, run: async (c, i) => { const d = await F.expiring(c.t, i.days, c.now); return { data: d, href: C.expiringCard(d, en).href }; } }),
  tool({ name: 'expired', description: 'Batches already past expiry and still on the shelf.', input: none, run: async (c) => { const d = await F.expired(c.t, c.now); return { data: d, href: C.expiredCard(d, en).href }; } }),
  tool({ name: 'customer_dues', description: 'Udhaar customers owe the shop: everyone (biggest first) or customers matching a name.', input: maybeName, run: async (c, i) => { const d = await F.udhaarOf(c.t, i.name ?? null); return { data: d, href: C.udhaarCard(d, en).href }; } }),
  tool({ name: 'supplier_dues', description: 'What the shop owes suppliers: everyone (biggest first, with overdue) or suppliers matching a name.', input: maybeName, run: async (c, i) => { const d = await F.supplierDues(c.t, i.name ?? null, c.now); return { data: d, href: C.suppliersCard(d, en).href }; } }),
  tool({ name: 'same_salt', description: 'Products in stock with the same salt and strength as a product (substitutes).', input: nameInput, run: async (c, i) => { const d = await F.sameSalt(c.t, i.name); return { data: d, href: C.saltCard(d, en).href }; } }),
  tool({ name: 'cash_today', description: 'Cash that should be in the drawer today: opening, cash in, cash out.', input: none, run: async (c) => { const d = await F.cashToday(c.t, c.now); return { data: d, href: C.cashCard(d, en).href }; } }),
];

export const toolDefs = (): Anthropic.Tool[] =>
  TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.input) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema as Anthropic.Tool.InputSchema };
  });

const MONEY = new Set(['netSales', 'gross', 'returns', 'avgBill', 'amount', 'total', 'due', 'limit', 'mrpValue', 'value', 'opening', 'cashIn', 'cashOut', 'expected', 'revenue', 'cogs', 'overdue', 'dueWeek', 'points']);
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const MAX = 3000;

/** Money as "₹1,234", dates as "9 Oct 2026", ids left out — the model copies figures, it never works them out. */
export function forModel(data: unknown): string {
  const json = JSON.stringify(data, (k, v: unknown) => {
    if (k === 'id' || k === 'productId') return undefined;
    if (typeof v === 'number' && MONEY.has(k)) return inr(v).replace(/\.00$/, '');
    if (typeof v === 'string' && ISO.test(v)) return dayLabel(new Date(v));
    return v;
  });
  return json.length > MAX ? `${json.slice(0, MAX)}…` : json;
}

export interface ToolRun {
  name: string;
  ok: boolean;
  text: string;
  href?: string;
}

export async function runTool(c: Ctx, name: string, input: unknown): Promise<ToolRun> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { name, ok: false, text: JSON.stringify({ error: 'No such tool' }) };
  const parsed = t.input.safeParse(input ?? {});
  if (!parsed.success) return { name, ok: false, text: JSON.stringify({ error: 'Bad input', issues: parsed.error.issues.map((x) => x.message) }) };
  try {
    const r = await t.run(c, parsed.data);
    return { name, ok: true, text: forModel(r.data), href: r.href };
  } catch (err) {
    if (err instanceof F.NoAccess) return { name, ok: false, text: JSON.stringify({ error: 'This person’s role cannot see this' }) };
    throw err;
  }
}
