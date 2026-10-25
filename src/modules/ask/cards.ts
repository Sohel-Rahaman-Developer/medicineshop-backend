import { dayLabel, monthLabel } from '../../utils/date';
import { inr } from '../../utils/money';
import { LINK, todoHead } from '../brief/brief.mail';
import type { Brief } from '../brief/brief.service';
import { BUY_DAYS } from './facts';
import type * as F from './facts';
import { langOf, type Voice } from './lang';
import { CHIPS, LABEL, MODE, PERIOD, TEXT, TITLE, WEEKDAY, say } from './texts';

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

export function expensesCard(d: Awaited<ReturnType<typeof F.expensesIn>>, v: Voice): Card {
  return card(say(TITLE.expenses, v, { period: periodText(d.period, v) }), {
    rows: [
      { label: say(LABEL.total, v), value: rs(d.total), tone: d.total ? 'warn' : 'ok' },
      { label: say(LABEL.entries, v), value: String(d.entries) },
    ],
    items: d.items.map((i) => ({ name: i.category, value: rs(i.total), sub: `× ${String(i.n)}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/expenses',
  });
}

export function purchasesCard(d: Awaited<ReturnType<typeof F.purchasesIn>>, v: Voice): Card {
  return card(say(TITLE.purchases, v, { period: periodText(d.period, v) }), {
    rows: [
      { label: say(LABEL.purchaseTotal, v), value: rs(d.total) },
      { label: say(LABEL.bills, v), value: String(d.invoices) },
      { label: say(LABEL.paid, v), value: rs(d.paid), tone: 'ok' },
      { label: say(LABEL.stillOwe, v), value: rs(d.due), tone: d.due ? 'warn' : 'ok' },
      ...(d.returns ? [{ label: say(LABEL.returns, v), value: rs(d.returns) }] : []),
    ],
    href: '/purchases',
  });
}

export function priceCard(d: Awaited<ReturnType<typeof F.priceOf>>, v: Voice): Card {
  const p = d.found;
  if (!p) return card(say(TITLE.price, v, { name: d.name }), { note: say(TEXT.notFound, v, { name: d.name }), href: '/products' });
  return card(say(TITLE.price, v, { name: p.name }), {
    rows: [
      ...(p.batches[0] ? [{ label: say(LABEL.per, v, { unit: p.sale.toLowerCase() }), value: rs(p.batches[0].mrp) }] : []),
      { label: say(LABEL.gstRate, v), value: `${String(p.gstRate)}%` },
    ],
    items: p.batches.map((b) => ({ name: `${say(LABEL.batch, v)} ${b.batchNumber}`, value: rs(b.mrp), sub: monthLabel(b.expiryDate) })),
    note: p.batches.length ? undefined : say(TEXT.none, v),
    href: `/products/${p.id}`,
  });
}

export function deadCard(d: Awaited<ReturnType<typeof F.notSelling>>, v: Voice): Card {
  return card(say(TITLE.dead, v, { n: d.days }), {
    rows: [
      { label: say(LABEL.products, v), value: String(d.count), tone: d.count ? 'warn' : 'ok' },
      { label: say(LABEL.mrpValue, v), value: rs(d.mrpValue) },
      ...(d.value === null ? [] : [{ label: say(LABEL.costValue, v), value: rs(d.value) }]),
    ],
    items: d.items.map((p) => ({ name: p.name, value: qty(p.qty), sub: p.lastSold ? `${say(LABEL.lastSold, v)}: ${dayLabel(p.lastSold)}` : say(LABEL.never, v), href: `/products/${p.id}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/analytics',
  });
}

export function customersCard(d: Awaited<ReturnType<typeof F.topCustomers>>, v: Voice): Card {
  return card(say(TITLE.customers, v, { period: periodText(d.period, v) }), {
    items: d.items.map((c) => ({ name: c.name, value: rs(c.amount), sub: `${say(LABEL.bills, v)}: ${String(c.bills)}`, href: `/customers/${c.id}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/customers',
  });
}

const modeName = (mode: string, v: Voice) => {
  const m = MODE[mode];
  return m ? say(m, v) : mode;
};

export function modesCard(d: Awaited<ReturnType<typeof F.payModes>>, v: Voice): Card {
  return card(say(TITLE.modes, v, { period: periodText(d.period, v) }), {
    rows: [
      ...d.items.map((i) => ({ label: modeName(i.mode, v), value: rs(i.amount), tone: i.mode === 'CREDIT' ? ('warn' as const) : undefined })),
      { label: say(LABEL.moneyIn, v), value: rs(d.total), tone: 'ok' },
    ],
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/sales',
  });
}

export function ordersCard(d: Awaited<ReturnType<typeof F.openOrders>>, v: Voice): Card {
  return card(say(TITLE.orders, v), {
    rows: [
      { label: say(LABEL.waiting, v), value: String(d.open), tone: d.open ? 'warn' : 'ok' },
      { label: say(LABEL.ready, v), value: String(d.ready), tone: d.ready ? 'ok' : undefined },
      ...(d.stale ? [{ label: say(LABEL.stale, v), value: String(d.stale), tone: 'danger' as const }] : []),
      { label: say(LABEL.advance, v), value: rs(d.advanceHeld) },
    ],
    items: d.items.map((o) => ({ name: o.customer, value: o.advance ? rs(o.advance) : '', sub: `${o.number} · ${dayLabel(o.at)}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/orders',
  });
}

export function gstCard(d: Awaited<ReturnType<typeof F.gstOf>>, v: Voice): Card {
  return card(say(TITLE.gst, v, { month: monthLabel(new Date(`${d.month}-15T00:00:00Z`)) }), {
    rows: [
      { label: say(LABEL.revenue, v), value: rs(d.salesTaxable) },
      { label: say(LABEL.outTax, v), value: rs(d.outTax) },
      { label: say(LABEL.inTax, v), value: rs(d.inTax) },
      d.net >= 0 ? { label: say(LABEL.net, v), value: rs(d.net), tone: 'warn' } : { label: say(LABEL.credit, v), value: rs(-d.net), tone: 'ok' },
    ],
    href: '/gst',
  });
}

export function staffCard(d: Awaited<ReturnType<typeof F.staffSales>>, v: Voice): Card {
  return card(say(TITLE.staff, v, { period: periodText(d.period, v) }), {
    items: d.items.map((s) => ({ name: s.name, value: rs(s.amount), sub: `${say(LABEL.bills, v)}: ${String(s.bills)}` })),
    note: d.items.length ? undefined : say(TEXT.none, v),
    href: '/sales',
  });
}

const change = (p: number | null) => (p === null ? '' : p === 0 ? ' · 0%' : ` · ${p > 0 ? '▲' : '▼'} ${String(Math.abs(p))}%`);
const toneOf = (p: number | null) => (p === null || p === 0 ? undefined : p > 0 ? ('ok' as const) : ('warn' as const));
const span = (from: Date, to: Date) => {
  const a = dayLabel(from);
  const b = dayLabel(new Date(to.getTime() - 1));
  return a === b ? a : `${a} – ${b}`;
};

/** v1.30: the same stretch of time side by side — the free answer to "this month vs last month". */
export function compareCard(d: Awaited<ReturnType<typeof F.compare>>, v: Voice): Card {
  const was = say(LABEL.before, v);
  const pair = (a: string, b: string, p: number | null) => `${a} · ${was} ${b}${change(p)}`;
  const { now: a, before: b, changePercent: c } = d;
  return card(say(TITLE[`compare_${d.key}`], v), {
    rows: [
      { label: say(LABEL.netSale, v), value: pair(rs(a.netSales), rs(b.netSales), c.sales), tone: toneOf(c.sales) },
      { label: say(LABEL.bills, v), value: pair(String(a.bills), String(b.bills), c.bills), tone: toneOf(c.bills) },
      { label: say(LABEL.avgBill, v), value: pair(rs(a.avgBill), rs(b.avgBill), c.averageBill) },
      ...(a.grossProfit !== null && b.grossProfit !== null ? [{ label: say(LABEL.grossProfit, v), value: pair(rs(a.grossProfit), rs(b.grossProfit), c.profit), tone: toneOf(c.profit) }] : []),
    ],
    note: say(TEXT.compareNote, v, { now: span(a.from, a.to), before: span(b.from, b.to) }),
    href: '/sales',
  });
}

export function marginsCard(d: Awaited<ReturnType<typeof F.itemMargins>>, v: Voice): Card {
  return card(say(d.order === 'low' ? TITLE.marginsLow : TITLE.marginsHigh, v, { period: periodText(d.period, v) }), {
    items: d.items.map((i) => ({ name: i.name, value: `${String(i.marginPercent)}%`, sub: `${say(LABEL.revenue, v)}: ${rs(i.revenue)} · ${say(LABEL.grossProfit, v)}: ${rs(i.grossProfit)}`, href: `/products/${i.id}` })),
    note: say(d.items.length ? TEXT.marginNote : TEXT.none, v),
    href: '/pnl',
  });
}

export function cheaperCard(d: Awaited<ReturnType<typeof F.buyPrices>>, v: Voice): Card {
  const note = say(TEXT.buyNote, v, { n: BUY_DAYS });
  if (d.name !== null) {
    const p = d.found;
    if (!p) return card(say(TITLE.buyOf, v, { name: d.name }), { note: say(TEXT.notFound, v, { name: d.name }), href: '/products' });
    return card(say(TITLE.buyOf, v, { name: p.name }), {
      rows: p.couldSave ? [{ label: say(LABEL.couldSave, v), value: rs(p.couldSave), tone: 'warn' }] : [],
      items: p.suppliers.map((s) => ({ name: s.supplier, value: rs(s.packCost), sub: dayLabel(s.lastBought) })),
      note: p.suppliers.length ? note : say(TEXT.none, v),
      href: `/products/${p.id}`,
    });
  }
  return card(say(TITLE.cheaper, v), {
    items: d.items.map((p) => {
      const cheap = p.suppliers[0];
      const dear = p.suppliers.at(-1);
      return { name: p.name, value: `${say(LABEL.couldSave, v)} ${rs(p.couldSave)}`, sub: cheap && dear ? `${cheap.supplier} ${rs(cheap.packCost)} · ${dear.supplier} ${rs(dear.packCost)}` : undefined, href: `/products/${p.id}` };
    }),
    note: d.items.length ? note : say(TEXT.none, v),
    href: '/purchases',
  });
}

export function busyCard(d: Awaited<ReturnType<typeof F.busyHours>>, v: Voice): Card {
  const most = <T extends { bills: number }>(xs: T[]) => [...xs].sort((x, y) => y.bills - x.bills);
  const bills = (n: number) => `${say(LABEL.bills, v)}: ${String(n)}`;
  return card(say(TITLE.busy, v, { period: periodText(d.period, v) }), {
    rows: most(d.byHour).slice(0, 3).map((h) => ({ label: h.hour, value: bills(h.bills) })),
    items: most(d.byDay).map((x) => {
      const day = WEEKDAY[x.day];
      return { name: day ? say(day, v) : x.day, value: rs(x.amount), sub: bills(x.bills) };
    }),
    note: say(d.byHour.length ? TEXT.busyNote : TEXT.none, v),
    href: '/sales',
  });
}

export function briefCard(b: Brief, v: Voice): Card {
  const p = b.changePercent;
  return card(say(TITLE.brief, v), {
    rows: [
      { label: say(LABEL.ySale, v), value: rs(b.yesterday.netSales) },
      { label: say(LABEL.yBills, v), value: String(b.yesterday.bills) },
      ...(p === null ? [] : [{ label: say(LABEL.vsUsual, v), value: change(p).slice(3), tone: toneOf(p) }]),
    ],
    items: b.todo.map((x) => ({ name: todoHead(x, langOf(v)), value: '', href: LINK[x.kind] })),
    note: say(b.todo.length ? TEXT.briefNote : TEXT.briefClear, v),
    href: '/brief',
  });
}

export const helpCard = (v: Voice): Card => card(say(TITLE.help, v), { items: CHIPS[langOf(v)].map((q) => ({ name: q, value: '' })) });

export const noteCard = (title: string, note: string): Card => card(title, { note });
