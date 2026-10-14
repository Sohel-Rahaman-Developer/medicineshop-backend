import type { ClientSession, Types } from 'mongoose';
import { inTransaction } from '../../core/transaction';
import { ShopModel } from '../shops/shop.model';
import { aiSettings } from './ai-settings';
import { CoinWalletModel } from './ai.model';
import { moveCoins } from './coins';

/** D96: every shop's free AI coins, once — at sign-up, and from the scheduler for shops made before. */
export async function giveWelcome(shopId: Types.ObjectId, session?: ClientSession): Promise<number> {
  const n = (await aiSettings()).welcomeCoins;
  if (n <= 0) return 0;
  const work = async (s: ClientSession) => {
    await CoinWalletModel.updateOne({ shopId }, { $setOnInsert: { balance: 0, askFree: 0 } }, { upsert: true, session: s });
    const claimed = await CoinWalletModel.updateOne({ shopId, welcomeAt: { $exists: false } }, { $set: { welcomeAt: new Date() } }, { session: s });
    if (!claimed.modifiedCount) return 0;
    await moveCoins(shopId, 'welcome', n, `Welcome — ${String(n)} free AI tokens from MedBox24`, 'MedBox24', 'welcome', s);
    return n;
  };
  return session ? work(session) : inTransaction(work);
}

/** Shops that have not had theirs yet, a batch at a time. */
export async function welcomeMissing(limit = 100): Promise<number> {
  if ((await aiSettings()).welcomeCoins <= 0) return 0;
  const done = await CoinWalletModel.distinct('shopId', { shopId: { $exists: true }, welcomeAt: { $exists: true } });
  const shops = await ShopModel.find({ _id: { $nin: done } }).select('_id').limit(limit).lean();
  let given = 0;
  for (const s of shops) if (await giveWelcome(s._id)) given += 1;
  return given;
}
