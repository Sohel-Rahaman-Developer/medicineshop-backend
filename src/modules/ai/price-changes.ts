import { changeStart, priceOf, type AiSettings } from './ai-settings';
import { AI_MODELS, AI_PRICE_CHANGES } from './ai.model';
import { PAGE_IN, PAGE_OUT, checks, coinValue } from './guard';

const DAY = 86_400_000;
/** The super admins hear of a rise this long before it, while the model is in use. */
export const NOTICE_DAYS = 7;

/** Announced rises still ahead, and what bill reading and the chat would do at the new price if nothing changes. */
export function upcomingPrices(s: AiSettings, now = new Date()) {
  const coin = coinValue(s);
  return AI_PRICE_CHANGES.filter((c) => changeStart(c.from) > now).map((c) => {
    const at = changeStart(c.from);
    const cur = priceOf(s, c.model);
    const next = { model: c.model, input: Math.max(cur.input, c.input), output: Math.max(cur.output, c.output), cacheRead: Math.max(cur.cacheRead, c.input / 10), cacheWrite: Math.max(cur.cacheWrite, c.input * 1.25) };
    const after = checks({ ...s, prices: s.prices.map((p) => (p.model === c.model ? next : p)) });
    const uses = after
      .filter((k) => (k.feature === 'read' ? s.model : s.chat.model) === c.model)
      .map((k) => ({ feature: k.feature, on: k.on, tokensIn: k.feature === 'read' ? PAGE_IN : s.chat.capIn, tokensOut: k.feature === 'read' ? PAGE_OUT : s.chat.capOut, coins: k.feature === 'read' ? s.coinsPerPage : s.chat.coinsPerQuestion, worstPaise: k.worstPaise, chargePaise: k.chargePaise, safe: k.safe, needCoins: Math.max(1, Math.ceil(k.worstPaise / Math.max(1, coin))) }));
    return { model: c.model, name: AI_MODELS[c.model].name, from: at, days: Math.ceil((at.getTime() - now.getTime()) / DAY), now: { input: cur.input, output: cur.output }, next: { input: next.input, output: next.output, dearIn: Math.max(next.input, next.cacheWrite) }, usdInr: s.usdInr, coinPaise: coin, uses };
  });
}
export type PriceChange = ReturnType<typeof upcomingPrices>[number];

/** Rises within the notice window for a model bill reading or the chat uses — the daily job emails each once. */
export const noticesDue = (s: AiSettings, now = new Date()) => upcomingPrices(s, now).filter((c) => c.days <= NOTICE_DAYS && c.uses.length > 0);
