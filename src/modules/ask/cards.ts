import { dayLabel, monthLabel } from '../../utils/date';
import { inr } from '../../utils/money';
import type * as F from './facts';
import { langOf, type Voice } from './lang';
import { CHIPS, LABEL, PERIOD, TEXT, TITLE, say } from './texts';

// D81: a free answer is a card — numbers the server worked out, labels in the asker's language, and a link to the
// screen with the whole picture (show the working).

export interface Card {
  title: string;
  rows: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }[];
  items: { name: string; value: string; sub?: string; href?: string }[];
  note?: string;
  href?: string;
}

const rs = (paise: number) => inr(paise).replace(/\.00$/, '');
const qty = (q: { packs: number; loose: number; sale: string; base: string }) => [q.packs || !q.loose ? `${String(q.packs)} ${q.sale.toLowerCase()}` : '', q.loose ? `${String(q.loose)} ${q.base.toLowerCase()}` : ''].filter(Boolean).join(' + ');
const periodText = (p: F.Period, v: Voice) => (p.key === 'days' ? say(PERIOD.days, v, { n: p.n }) : say(PERIOD[p.key], v));
const card = (title: string, part: Partial<Card> = {}): Card => ({ title, rows: [], items: [], ...part });

export function salesCard(d: Awaited<ReturnType<typeof F.sales>>, v: Voice): Card {
  return card(say(TITLE.sales, v, { period: periodText(d.period, v) }), {
    rows: [
      { label: say(LABEL.netSale, v), value: rs(d.netSales) },
      { label: say(LABEL.bills, v), value: String(d.bills) },
      { label: say(LABEL.avgBill, v), value: rs(d.avgBill) },
      ...(d.returns ? [{ label: say(LABEL.returns, v), value: rs(d.returns), tone: 'warn' as const }] : []),
      ...(d.cancelled ? [{ label: say(LABEL.cancelled, v), value: String(d.cancelled), tone: 'warn' as const }] : []),
    ],
    href: '/sales',
  });
}

export function profitCard(d: Awaited<ReturnType<typeof F.profit>>, v: Voice): Card {
  const p = d.profit;
  return card(say(TITLE.profit, v, { period: periodText(d.period, v) }), {
    rows: p
      ? [
          { label: say(LABEL.grossProfit, v), value: rs(p.gross), tone: p.gross < 0 ? 'danger' : 'ok' },
          { label: say(LABEL.revenue, v), value: rs(p.revenue) },
          { label: say(LABEL.cost, v), value: rs(p.cogs) },
          { label: say(LABEL.margin, v), value: `${String(p.margin)}%` },
        ]
      : [],
    href: '/pnl',
  });
}

export function topCard(d: Awaited<ReturnType<typeof F.topItems>>, v: Voice): Card {
  return card(say(TITLE.top, v, { period: periodText(d.period, v) }), {
    items: d.items.map((i) => ({ name: i.name, value: rs(i.amount), sub: `× ${String(i.packs)}`, href: `/products/${i.id}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/sales',
  });
}

export function stockCard(d: Awaited<ReturnType<typeof F.stockOf>>, v: Voice): Card {
  const p = d.found;
  if (!p) return card(say(TITLE.stockOf, v, { name: d.name }), { note: say(TEXT.notFound, v, { name: d.name }), href: '/products' });
  return card(say(TITLE.stockOf, v, { name: p.name }), {
    rows: [
      { label: say(LABEL.inStock, v), value: qty(p.qty), tone: p.status === 'out' ? 'danger' : p.status === 'low' ? 'warn' : 'ok' },
      ...(p.nextExpiry ? [{ label: say(LABEL.nextExpiry, v), value: monthLabel(p.nextExpiry) }] : []),
    ],
    items: [
      ...p.batches.map((b) => ({ name: `${say(LABEL.batch, v)} ${b.batchNumber}`, value: qty(b.qty), sub: [monthLabel(b.expiryDate), b.rack ? `${say(LABEL.rack, v)} ${b.rack}` : ''].filter(Boolean).join(' · ') })),
      ...d.others.map((o) => ({ name: o.name, value: qty(o.qty), href: `/products/${o.id}` })),
    ],
    href: `/products/${p.id}`,
  });
}

export function stockSummaryCard(d: Awaited<ReturnType<typeof F.stockSummary>>, v: Voice): Card {
  return card(say(TITLE.stock, v), {
    rows: [
      { label: say(LABEL.products, v), value: String(d.products) },
      { label: say(LABEL.low, v), value: String(d.low), tone: d.low ? 'warn' : 'ok' },
      { label: say(LABEL.out, v), value: String(d.out), tone: d.out ? 'danger' : 'ok' },
      { label: say(LABEL.mrpValue, v), value: rs(d.mrpValue) },
      ...(d.value === null ? [] : [{ label: say(LABEL.stockValue, v), value: rs(d.value) }]),
    ],
    href: '/products',
  });
}

export function lowCard(d: Awaited<ReturnType<typeof F.lowStock>>, v: Voice): Card {
  return card(say(TITLE.low, v), {
    rows: [
      { label: say(LABEL.out, v), value: String(d.out), tone: d.out ? 'danger' : 'ok' },
      { label: say(LABEL.low, v), value: String(d.low), tone: d.low ? 'warn' : 'ok' },
    ],
    items: d.items.map((p) => ({ name: p.name, value: qty(p.qty), href: `/products/${p.id}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/reorder',
  });
}

function batchCard(title: string, d: Awaited<ReturnType<typeof F.expired>>, v: Voice): Card {
  return card(title, {
    rows: [
      { label: say(LABEL.batches, v), value: String(d.count), tone: d.count ? 'warn' : 'ok' },
      { label: say(LABEL.mrpValue, v), value: rs(d.mrpValue) },
    ],
    items: d.items.map((b) => ({ name: b.name, value: monthLabel(b.expiryDate), sub: [`${say(LABEL.batch, v)} ${b.batchNumber}`, `× ${String(b.packs)}`, b.rack ? `${say(LABEL.rack, v)} ${b.rack}` : ''].filter(Boolean).join(' · '), href: `/products/${b.productId}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/expiry',
  });
}
export const expiringCard = (d: Awaited<ReturnType<typeof F.expiring>>, v: Voice) => batchCard(say(TITLE.expiring, v, { n: d.days }), d, v);
export const expiredCard = (d: Awaited<ReturnType<typeof F.expired>>, v: Voice) => batchCard(say(TITLE.expired, v), d, v);

export function udhaarCard(d: Awaited<ReturnType<typeof F.udhaarOf>>, v: Voice): Card {
  if (d.name && !d.items.length) return card(say(TITLE.udhaarOf, v, { name: d.name }), { note: say(TEXT.notFound, v, { name: d.name }), href: '/credit' });
  const one = d.name && d.items.length === 1 ? d.items[0] : undefined;
  if (one) {
    return card(say(TITLE.udhaarOf, v, { name: one.name }), {
      rows: [{ label: say(LABEL.total, v), value: rs(one.due), tone: one.due > 0 ? 'warn' : 'ok' }, ...(one.limit ? [{ label: say(LABEL.limit, v), value: rs(one.limit) }] : [])],
      href: `/customers/${one.id}`,
    });
  }
  return card(say(d.name ? TITLE.udhaarOf : TITLE.udhaar, v, { name: d.name ?? '' }), {
    rows: d.name ? [] : [{ label: say(LABEL.total, v), value: rs(d.total), tone: d.total ? 'warn' : 'ok' }, { label: say(LABEL.customers, v), value: String(d.customers) }],
    items: d.items.map((c) => ({ name: c.name, value: rs(c.due), href: `/customers/${c.id}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/credit',
  });
}

export function suppliersCard(d: Awaited<ReturnType<typeof F.supplierDues>>, v: Voice): Card {
  if (d.name && !d.items.length) return card(say(TITLE.supplierOf, v, { name: d.name }), { note: say(TEXT.notFound, v, { name: d.name }), href: '/suppliers' });
  const s = d.summary;
  return card(d.name && d.items[0] ? say(TITLE.supplierOf, v, { name: d.items[0].name }) : say(TITLE.suppliers, v), {
    rows: s
      ? [
          { label: say(LABEL.total, v), value: rs(s.total), tone: s.total ? 'warn' : 'ok' },
          { label: say(LABEL.overdue, v), value: rs(s.overdue), tone: s.overdue ? 'danger' : 'ok' },
          { label: say(LABEL.dueWeek, v), value: rs(s.dueWeek) },
          { label: say(LABEL.suppliers, v), value: String(s.suppliers) },
        ]
      : [],
    items: d.items.map((x) => ({ name: x.name, value: rs(x.due), sub: x.oldestDue ? `${say(LABEL.oldestDue, v)}: ${dayLabel(x.oldestDue)}` : undefined, href: `/suppliers/${x.id}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/suppliers',
  });
}

export function saltCard(d: Awaited<ReturnType<typeof F.sameSalt>>, v: Voice): Card {
  if (!d.found) return card(say(TITLE.sameSalt, v, { name: d.name }), { note: say(TEXT.notFound, v, { name: d.name }), href: '/products' });
  return card(say(TITLE.sameSalt, v, { name: d.found.name }), {
    items: d.items.map((p) => ({ name: p.name, value: `${String(p.packs)} ${p.sale.toLowerCase()}`, sub: [p.salt, p.company].filter(Boolean).join(' · '), href: `/products/${p.id}` })),
    note: d.noSalt ? say(TEXT.noSalt, v) : d.items.length ? undefined : say(TEXT.none, v),
    href: `/products/${d.found.id}`,
  });
}

export function cashCard(d: Awaited<ReturnType<typeof F.cashToday>>, v: Voice): Card {
  return card(say(TITLE.cash, v), {
    rows: [
      { label: say(LABEL.expected, v), value: rs(d.expected), tone: 'ok' },
      { label: say(LABEL.opening, v), value: rs(d.opening) },
      { label: say(LABEL.cashIn, v), value: rs(d.cashIn) },
      { label: say(LABEL.cashOut, v), value: rs(d.cashOut) },
      { label: say(LABEL.bills, v), value: String(d.bills) },
    ],
    href: '/day-close',
  });
}

export const helpCard = (v: Voice): Card => card(say(TITLE.help, v), { items: CHIPS[langOf(v)].map((q) => ({ name: q, value: '' })) });

export const noteCard = (title: string, note: string): Card => card(title, { note });
