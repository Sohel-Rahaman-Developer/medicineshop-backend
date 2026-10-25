import { translate, type Lang } from '../../core/lang';
import { digestEmail } from '../../services/email-templates';
import { monthLabel } from '../../utils/date';
import { inr } from '../../utils/money';
import type { Brief } from './brief.service';

const rs = (p: number) => inr(p).replace(/\.00$/, '');
type Todo = Brief['todo'][number];
type Tr = (text: string) => string;

// Whole sentences, one and many apart, each inside tr() so it translates as it stands (core/lang).
function card(x: Todo, tr: Tr): { head: string; lines: string[] } {
  if (x.kind === 'reorder') {
    return {
      head: tr(x.count === 1 ? '1 medicine to reorder' : `${String(x.count)} medicines to reorder`),
      lines: x.items.slice(0, 3).map((i) => (i.out ? tr(`${i.name}: out of stock`) : i.lastsDays === null ? tr(`${i.name}: only ${String(i.left)} left`) : tr(`${i.name}: only ${String(i.left)} left, lasts about ${String(i.lastsDays)} days`))),
    };
  }
  if (x.kind === 'expiry') {
    return {
      head: tr(x.count === 1 ? `1 batch expires within ${String(x.days)} days — ${rs(x.mrpValue)} at MRP` : `${String(x.count)} batches expire within ${String(x.days)} days — ${rs(x.mrpValue)} at MRP`),
      lines: [...(x.expired ? [tr(x.expired === 1 ? '1 batch already expired — take it off the shelf' : `${String(x.expired)} batches already expired — take them off the shelf`)] : []), ...x.items.map((i) => `${i.name} · ${i.batchNumber} · ${monthLabel(i.expiryDate)}`)],
    };
  }
  if (x.kind === 'suppliers') return { head: tr(`Pay suppliers ${rs(x.dueWeek)} this week`), lines: x.overdue ? [tr(`${rs(x.overdue)} is already overdue`)] : [] };
  if (x.kind === 'udhaar') return { head: tr(x.customers === 1 ? `Collect ${rs(x.total)} udhaar from 1 customer` : `Collect ${rs(x.total)} udhaar from ${String(x.customers)} customers`), lines: x.items.map((i) => `${i.name} — ${rs(i.due)}`) };
  if (x.kind === 'refill') return { head: tr(x.count === 1 ? '1 regular customer is due for a refill' : `${String(x.count)} regular customers are due for a refill`), lines: x.items.map((i) => `${i.name} — ${i.product}`) };
  return { head: tr(x.count === 1 ? `${rs(x.mrpValue)} stuck in 1 medicine not sold for ${String(x.days)} days` : `${rs(x.mrpValue)} stuck in ${String(x.count)} medicines not sold for ${String(x.days)} days`), lines: [tr('Offer them, return them, or stop buying them.')] };
}

export const LINK = { reorder: '/reorder', expiry: '/expiry', suppliers: '/suppliers', udhaar: '/credit', refill: '/refills', dead: '/brief' } as const;

/** One job's headline in the reader's language — the chat's brief card uses the mail's own sentences. */
export const todoHead = (x: Todo, lang: Lang) => card(x, (text) => translate(lang, text)).head;

/** The brief as the morning mail: yesterday first, then the jobs as cards, then the AI to ask. */
export function briefEmail(b: Brief, shop: string, lang: Lang) {
  const tr: Tr = (text) => translate(lang, text);
  const y = b.yesterday;
  const n = b.usual?.days.length ?? 0;
  const avg = rs(b.usual?.average ?? 0);
  const pct = Math.abs(b.changePercent ?? 0);
  const usual = b.changePercent === null ? [] : [tr(b.changePercent >= 0 ? `${String(pct)}% more than a usual day like it (${avg}, same weekday, last ${String(n)} weeks)` : `${String(pct)}% less than a usual day like it (${avg}, same weekday, last ${String(n)} weeks)`)];
  const profit = y.grossProfit !== null && y.marginPercent !== null ? [tr(`Gross profit ${rs(y.grossProfit)} (${String(y.marginPercent)}% margin)`)] : [];
  const blocks = [
    { head: tr(y.bills === 1 ? `Yesterday: ${rs(y.netSales)} · 1 bill` : `Yesterday: ${rs(y.netSales)} · ${String(y.bills)} bills`), lines: [...usual, ...profit], link: '/brief' },
    ...b.todo.map((x) => ({ ...card(x, tr), link: LINK[x.kind] })),
    { head: tr('Ask the AI what to do first'), lines: [tr('It reads this brief and your own figures — one AI token, in Ask your shop.')], link: '/brief' },
  ];
  const title = blocks[0]?.head ?? '';
  return { title, ...digestEmail(shop, tr('Your morning brief'), blocks, lang) };
}
