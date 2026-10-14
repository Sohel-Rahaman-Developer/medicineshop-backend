import { CoinWalletModel } from './ai.model';
import { providerOf, readyFor, type AiSettings } from './ai-settings';
import { safeNow } from './guard';

/** What keeps a feature from the shops, in the order to fix it: its model's key, a free-tier key under the chat, a losing price, the switch. */
export type Block = 'key' | 'freeTier' | 'loss' | 'off';
export type Feature = 'read' | 'chat';

export function blocksOf(s: AiSettings, f: Feature): Block[] {
  const model = f === 'read' ? s.model : s.chat.model;
  const blocks: Block[] = [];
  if (!readyFor(s, model)) blocks.push('key');
  else if (f === 'chat' && providerOf(model) === 'google' && !s.gemini.paid) blocks.push('freeTier');
  if (!safeNow(s, f)) blocks.push('loss');
  if (!(f === 'read' ? s.enabled : s.chat.enabled)) blocks.push('off');
  return blocks;
}

/** Is each AI feature reaching the shops, and if not, why — for the status card on top of the admin's AI pages. */
export async function aiStatus(s: AiSettings) {
  const shopsOn = await CoinWalletModel.countDocuments({ askAi: true }).setOptions({ crossTenant: true });
  return {
    read: { model: s.model, blocks: blocksOf(s, 'read') },
    chat: { model: s.chat.model, blocks: blocksOf(s, 'chat'), shopsOn },
  };
}
