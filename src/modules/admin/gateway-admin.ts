import { STATES } from '../../utils/india';
import { WebhookEventModel } from '../subscription/billing.model';
import { clearKeys, gatewaySettings, saveBilling, saveKeys, setActive, testKeys, type BillingInput, type GatewayActive, type GatewaySet, type KeysInput } from '../subscription/gateway';
import type { AdminActor } from './admin-auth';
import { log } from './admin.service';

/** D95: the Razorpay page — keys (last 4 only), which account takes money, MedBox24's invoice details, the last webhook. */
export async function gatewayOverview() {
  const [s, last] = await Promise.all([gatewaySettings(), WebhookEventModel.findOne({ provider: 'razorpay' }).sort({ createdAt: -1 }).select('event signatureValid result createdAt').lean()]);
  return {
    ...s,
    lastWebhook: last ? { event: last.event, valid: last.signatureValid, result: last.result, at: last.createdAt } : null,
    states: STATES.map((x) => x.name),
  };
}

export async function updateKeys(a: AdminActor, set: GatewaySet, input: KeysInput, reason: string, ip?: string) {
  await saveKeys(set, input, a.name);
  const parts = [`key ID ${input.keyId}`, input.keySecret ? `secret …${input.keySecret.slice(-4)}` : '', input.webhookSecret ? `webhook secret …${input.webhookSecret.slice(-4)}` : ''].filter(Boolean);
  await log(a, 'gateway_keys_set', reason, `saved the Razorpay ${set} keys (${parts.join(', ')})`, undefined, undefined, ip);
  return gatewayOverview();
}

export async function removeKeys(a: AdminActor, set: GatewaySet, reason: string, ip?: string) {
  await clearKeys(set, a.name);
  await log(a, 'gateway_keys_removed', reason, `removed the Razorpay ${set} keys`, undefined, undefined, ip);
  return gatewayOverview();
}

const ACCOUNT: Record<GatewayActive, string> = { off: 'off — no online payments', test: 'the Razorpay test keys', live: 'the Razorpay live keys — real money' };
export async function switchActive(a: AdminActor, active: GatewayActive, reason: string, ip?: string) {
  const before = (await gatewaySettings()).active;
  await setActive(active, a.name);
  await log(a, 'gateway_switched', reason, `switched online payments to ${ACCOUNT[active]}`, undefined, { before: before ?? 'server env', after: active }, ip);
  return gatewayOverview();
}

export async function updateBilling(a: AdminActor, input: BillingInput, reason: string, ip?: string) {
  const before = (await gatewaySettings()).billingSet;
  await saveBilling(input, a.name);
  await log(a, 'gateway_billing', reason, `invoice details: GSTIN ${input.gstin || '—'}, ${input.state}, SAC ${input.sac}`, undefined, { before, after: input }, ip);
  return gatewayOverview();
}

export const testGatewayKeys = (set: GatewaySet) => testKeys(set);
