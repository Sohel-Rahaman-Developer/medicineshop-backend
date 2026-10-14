import type { Types } from 'mongoose';
import { AskQuestionModel } from '../ask/ask.model';
import { ShopModel } from '../shops/shop.model';
import { aiSettings, priceOf } from './ai-settings';
import { AiReadModel, CoinEntryModel, CoinOrderModel, CoinWalletModel } from './ai.model';
import { PAGE_IN, PAGE_OUT, checks, coinValue, worstPage, worstQuestion } from './guard';

// D97: the admin's money view of AI — is every price safe, what margin it really makes, and which shop (and who in it)
// spends how much against what it paid.

const DAY = 86_400_000;
const GST = 1.18;
const AI_ROUTES = { $in: ['ai', 'off_topic'] };

type Sum = { _id: Types.ObjectId; cost: number; done: number; failed: number; coins: number; month: number };
type UserSum = { _id: { shop: Types.ObjectId; user: string }; cost: number; n: number };

export async function aiMoney(now = new Date()) {
  const s = await aiSettings();
  const since = new Date(now.getTime() - 30 * DAY);
  const coin = coinValue(s);
  const month = (field: string) => ({ $sum: { $cond: [{ $gte: ['$createdAt', since] }, field, 0] } });
  const [reads, asks, readUsers, askUsers, paid, gifts, avgRead, avgAsk] = await Promise.all([
    AiReadModel.aggregate<Sum>([{ $group: { _id: '$shopId', cost: { $sum: '$costPaise' }, done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, coins: { $sum: { $cond: ['$refunded', 0, '$coins'] } }, month: month('$costPaise') } }]),
    AskQuestionModel.aggregate<Sum>([{ $match: { route: AI_ROUTES } }, { $group: { _id: '$shopId', cost: { $sum: '$costPaise' }, done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }, coins: { $sum: { $cond: ['$refunded', 0, '$coins'] } }, month: month('$costPaise') } }]),
    AiReadModel.aggregate<UserSum>([{ $group: { _id: { shop: '$shopId', user: '$userName' }, cost: { $sum: '$costPaise' }, n: { $sum: 1 } } }]),
    AskQuestionModel.aggregate<UserSum>([{ $match: { route: AI_ROUTES } }, { $group: { _id: { shop: '$shopId', user: '$userName' }, cost: { $sum: '$costPaise' }, n: { $sum: 1 } } }]),
    CoinOrderModel.aggregate<{ _id: Types.ObjectId; net: number; month: number }>([{ $match: { status: 'paid' } }, { $group: { _id: '$shopId', net: { $sum: { $subtract: ['$amount', '$gst'] } }, month: { $sum: { $cond: [{ $gte: ['$paidAt', since] }, { $subtract: ['$amount', '$gst'] }, 0] } } } }]),
    CoinEntryModel.aggregate<{ _id: Types.ObjectId; coins: number }>([{ $match: { shopId: { $exists: true }, kind: { $in: ['grant', 'welcome'] } } }, { $group: { _id: '$shopId', coins: { $sum: '$coins' } } }]),
    AiReadModel.aggregate<{ cost: number; pages: number }>([{ $match: { createdAt: { $gte: since }, costPaise: { $gt: 0 } } }, { $group: { _id: null, cost: { $sum: '$costPaise' }, pages: { $sum: '$pages' } } }]),
    AskQuestionModel.aggregate<{ cost: number; n: number }>([{ $match: { createdAt: { $gte: since }, route: AI_ROUTES, costPaise: { $gt: 0 } } }, { $group: { _id: null, cost: { $sum: '$costPaise' }, n: { $sum: 1 } } }]),
  ]);

  // Shops in the money view: everyone who spent on AI or bought coins.
  const ids = new Map<string, Types.ObjectId>();
  for (const r of [...reads, ...asks, ...paid]) ids.set(String(r._id), r._id);
  const [shopRows, wallets] = await Promise.all([
    ShopModel.find({ _id: { $in: [...ids.values()] } }).select('name').lean(),
    CoinWalletModel.find({ shopId: { $in: [...ids.values()] } }).select('shopId balance askFree').lean(),
  ]);
  const shopNames = new Map(shopRows.map((x) => [String(x._id), x.name]));
  const get = <T extends { _id: Types.ObjectId }>(rows: T[], id: string) => rows.find((r) => String(r._id) === id);
  const users = new Map<string, Map<string, number>>();
  for (const u of [...readUsers, ...askUsers]) {
    const k = String(u._id.shop);
    const m = users.get(k) ?? new Map<string, number>();
    m.set(u._id.user, (m.get(u._id.user) ?? 0) + u.cost);
    users.set(k, m);
  }
  const shops = [...ids.keys()].map((id) => {
    const r = get(reads, id);
    const a = get(asks, id);
    const p = get(paid, id);
    const giftedCoins = Math.max(0, get(gifts, id)?.coins ?? 0);
    const burned = (r?.cost ?? 0) + (a?.cost ?? 0);
    const freeUsed = wallets.find((w) => String(w.shopId) === id)?.askFree ?? 0;
    const allowance = (p?.net ?? 0) + giftedCoins * coin + freeUsed * s.chat.coinsPerQuestion * coin;
    const earned = ((r?.coins ?? 0) + (a?.coins ?? 0)) * coin;
    return {
      shopId: id,
      shopName: shopNames.get(id) ?? '',
      paidPaise: p?.net ?? 0,
      giftedCoins,
      balance: wallets.find((w) => String(w.shopId) === id)?.balance ?? 0,
      reads: { done: r?.done ?? 0, failed: r?.failed ?? 0 },
      questions: { done: a?.done ?? 0, failed: a?.failed ?? 0 },
      coinsSpent: (r?.coins ?? 0) + (a?.coins ?? 0),
      costPaise: burned,
      monthCostPaise: (r?.month ?? 0) + (a?.month ?? 0),
      earnedPaise: earned,
      allowancePaise: allowance,
      leftPaise: allowance - burned,
      margin: burned ? Math.round((earned / burned) * 10) / 10 : null,
      users: [...(users.get(id)?.entries() ?? [])].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([name, cost]) => ({ name, costPaise: cost })),
    };
  }).sort((x, y) => y.costPaise - x.costPaise || y.paidPaise - x.paidPaise).slice(0, 50);

  const monthCost = reads.reduce((t, r) => t + r.month, 0) + asks.reduce((t, r) => t + r.month, 0);
  const monthSales = paid.reduce((t, r) => t + r.month, 0);
  const perPage = avgRead[0]?.pages ? Math.round(avgRead[0].cost / avgRead[0].pages) : null;
  const perQuestion = avgAsk[0]?.n ? Math.round(avgAsk[0].cost / avgAsk[0].n) : null;
  const m = s.targetMargin;
  const need = (cost: number) => Math.max(1, Math.ceil((m * cost) / Math.max(1, coin)));
  const [read, chat] = checks(s);
  const pr = priceOf(s, s.model);
  const pc = priceOf(s, s.chat.model);
  // The least price a coin must sell for (with GST) so each feature makes the target margin at its present coins a job.
  const floor = Math.max(perPage === null ? 0 : (m * perPage) / s.coinsPerPage, perQuestion === null ? 0 : (m * perQuestion) / s.chat.coinsPerQuestion);
  return {
    targetMargin: m,
    usdInr: s.usdInr,
    coin: { paise: coin, packs: s.packs.map((k) => ({ name: k.name, coins: k.coins, price: k.price, perCoin: Math.floor(k.price / GST / Math.max(1, k.coins)) })) },
    read: { ...read, model: s.model, coinsPerJob: s.coinsPerPage, tokensIn: PAGE_IN, tokensOut: PAGE_OUT, price: { input: Math.max(pr.input, pr.cacheWrite), output: pr.output }, avgPaise: perPage, suggestCoins: need(perPage ?? worstPage(s)) },
    chat: { ...chat, model: s.chat.model, coinsPerJob: s.chat.coinsPerQuestion, tokensIn: s.chat.capIn, tokensOut: s.chat.capOut, price: { input: Math.max(pc.input, pc.cacheWrite), output: pc.output }, avgPaise: perQuestion, suggestCoins: need(perQuestion ?? worstQuestion(s)) },
    month: { costPaise: monthCost, salesPaise: monthSales, margin: monthCost ? Math.round((monthSales / monthCost) * 10) / 10 : null },
    coinFloorPaise: Math.ceil(floor * GST),
    gifts: { welcomeCoins: s.welcomeCoins, perShopPaise: s.welcomeCoins * coin },
    shops,
  };
}
