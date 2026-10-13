import { Schema, model } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { stateCodeOf } from '../../utils/india';
import { open, seal } from '../../utils/totp';
import { platform } from '../admin/platform';

export const GATEWAY_SETS = ['test', 'live'] as const;
export type GatewaySet = (typeof GATEWAY_SETS)[number];
export const GATEWAY_ACTIVE = ['off', ...GATEWAY_SETS] as const;
export type GatewayActive = (typeof GATEWAY_ACTIVE)[number];

const keySetSchema = new Schema(
  {
    keyId: { type: String },
    secretSealed: { type: String },
    secretLast4: { type: String },
    webhookSealed: { type: String },
    webhookLast4: { type: String },
    setAt: { type: Date },
    setBy: { type: String },
  },
  { _id: false },
);
const gatewaySchema = new Schema(
  {
    _id: { type: String, default: 'razorpay' },
    /** Unset → the server's env, as before D95. */
    active: { type: String, enum: GATEWAY_ACTIVE },
    test: { type: keySetSchema },
    live: { type: keySetSchema },
    billing: { gstin: { type: String }, state: { type: String }, sac: { type: String } },
    updatedBy: { type: String },
  },
  { timestamps: true, versionKey: false },
);
export const GatewaySettingsModel = model('GatewaySettings', gatewaySchema);

// Its own key from the admin secret, apart from the TOTP secrets and the Claude key.
const sealKey = () => `${env.ADMIN_TOTP_KEY ?? env.JWT_ACCESS_SECRET}|razorpay-keys`;

export type PayMode = 'off' | 'test' | 'razorpay';
export interface Gateway { mode: PayMode; source: 'admin' | 'env'; account: GatewayActive | 'env'; keyId: string; keySecret: string; webhookSecret: string }

const TTL = 30_000;
let cached: { at: number; v: Gateway } | null = null;
export const forgetGateway = () => {
  cached = null;
};

interface KeySet { keyId?: string | null; secretSealed?: string | null; webhookSealed?: string | null; secretLast4?: string | null; webhookLast4?: string | null; setAt?: Date | null; setBy?: string | null }
const complete = (s: KeySet | null | undefined) => Boolean(s?.keyId && s.secretSealed && s.webhookSealed);

/** D95: the keys the admin saved win; until then the server's env, so nothing changes on deploy. */
export async function gateway(): Promise<Gateway> {
  if (cached && Date.now() - cached.at < TTL) return cached.v;
  const s = await GatewaySettingsModel.findById('razorpay').lean();
  let v: Gateway;
  if (s?.active === 'off') v = { mode: 'off', source: 'admin', account: 'off', keyId: '', keySecret: '', webhookSecret: '' };
  else if (s?.active === 'test' || s?.active === 'live') {
    const k = s[s.active];
    if (!k || !complete(k)) v = { mode: 'off', source: 'admin', account: 'off', keyId: '', keySecret: '', webhookSecret: '' };
    else v = { mode: 'razorpay', source: 'admin', account: s.active, keyId: k.keyId ?? '', keySecret: open(k.secretSealed ?? '', sealKey()), webhookSecret: open(k.webhookSealed ?? '', sealKey()) };
  } else v = { mode: env.PAYMENTS_MODE, source: 'env', account: 'env', keyId: env.RAZORPAY_KEY_ID ?? '', keySecret: env.RAZORPAY_KEY_SECRET ?? '', webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? '' };
  cached = { at: Date.now(), v };
  return v;
}

/** MedBox24 on its own invoices: name and address from Platform settings, GSTIN / state / SAC from here; env until set. */
export async function billingInfo() {
  const [s, p] = await Promise.all([GatewaySettingsModel.findById('razorpay').select('billing').lean(), platform()]);
  const state = s?.billing?.state || env.BILLING_STATE;
  return {
    legalName: p.legalName || env.BILLING_LEGAL_NAME,
    address: p.address || env.BILLING_ADDRESS,
    gstin: s?.billing?.gstin || env.BILLING_GSTIN || '',
    state,
    stateCode: stateCodeOf(state) ?? '',
    sac: s?.billing?.sac || env.BILLING_SAC,
  };
}

const shapeSet = (k: KeySet | null | undefined) => ({
  keyId: k?.keyId ?? null,
  secretLast4: k?.secretLast4 ?? null,
  webhookLast4: k?.webhookLast4 ?? null,
  setAt: k?.setAt ?? null,
  setBy: k?.setBy ?? null,
  complete: complete(k),
});

/** What the admin sees: never a secret, only its last 4. */
export async function gatewaySettings() {
  const [s, g, b] = await Promise.all([GatewaySettingsModel.findById('razorpay').lean(), gateway(), billingInfo()]);
  return {
    active: s?.active ?? null,
    mode: g.mode,
    source: g.source,
    envMode: env.PAYMENTS_MODE,
    test: shapeSet(s?.test),
    live: shapeSet(s?.live),
    billing: b,
    billingSet: { gstin: s?.billing?.gstin ?? null, state: s?.billing?.state ?? null, sac: s?.billing?.sac ?? null },
  };
}

export interface KeysInput { keyId: string; keySecret?: string; webhookSecret?: string }

/** A secret left blank keeps the saved one; the first save of a set needs all three. */
export async function saveKeys(set: GatewaySet, input: KeysInput, by: string) {
  if (!input.keyId.startsWith(`rzp_${set}_`)) throw AppError.validation(`A ${set} key ID starts with rzp_${set}_`, [{ field: 'body.keyId', message: `Starts with rzp_${set}_` }]);
  const s = await GatewaySettingsModel.findById('razorpay').lean();
  const had = s?.[set];
  if (!input.keySecret && !had?.secretSealed) throw AppError.validation('The key secret is needed the first time', [{ field: 'body.keySecret', message: 'Needed' }]);
  if (!input.webhookSecret && !had?.webhookSealed) throw AppError.validation('The webhook secret is needed the first time', [{ field: 'body.webhookSecret', message: 'Needed' }]);
  const $set: Record<string, unknown> = { [`${set}.keyId`]: input.keyId, [`${set}.setAt`]: new Date(), [`${set}.setBy`]: by, updatedBy: by };
  if (input.keySecret) Object.assign($set, { [`${set}.secretSealed`]: seal(input.keySecret, sealKey()), [`${set}.secretLast4`]: input.keySecret.slice(-4) });
  if (input.webhookSecret) Object.assign($set, { [`${set}.webhookSealed`]: seal(input.webhookSecret, sealKey()), [`${set}.webhookLast4`]: input.webhookSecret.slice(-4) });
  await GatewaySettingsModel.updateOne({ _id: 'razorpay' }, { $set }, { upsert: true });
  forgetGateway();
  return gatewaySettings();
}

export async function clearKeys(set: GatewaySet, by: string) {
  const s = await GatewaySettingsModel.findById('razorpay').select('active').lean();
  if (s?.active === set) throw AppError.conflict(`The ${set} keys are in use — switch to another first`, { reason: 'KEYS_IN_USE' });
  await GatewaySettingsModel.updateOne({ _id: 'razorpay' }, { $unset: { [set]: '' }, $set: { updatedBy: by } }, { upsert: true });
  forgetGateway();
  return gatewaySettings();
}

/** Live money needs real tax invoices, so the legal name, address and GSTIN first. */
export async function setActive(active: GatewayActive, by: string) {
  const s = await GatewaySettingsModel.findById('razorpay').lean();
  if (active !== 'off' && !complete(s?.[active])) throw AppError.validation(`Save the ${active} keys first`, [{ field: 'body.active', message: `No ${active} keys yet` }]);
  if (active === 'live') {
    const b = await billingInfo();
    const missing = [!b.legalName && 'legal name', !b.address && 'address', !b.gstin && 'GSTIN'].filter(Boolean);
    if (missing.length) throw AppError.validation(`Live payments need MedBox24's ${missing.join(', ')} on the invoices`, [{ field: 'body.active', message: `Missing ${missing.join(', ')}` }]);
  }
  await GatewaySettingsModel.updateOne({ _id: 'razorpay' }, { $set: { active, updatedBy: by } }, { upsert: true });
  forgetGateway();
  return gatewaySettings();
}

export interface BillingInput { gstin: string; state: string; sac: string }
export async function saveBilling(input: BillingInput, by: string) {
  await GatewaySettingsModel.updateOne({ _id: 'razorpay' }, { $set: { billing: input, updatedBy: by } }, { upsert: true });
  return gatewaySettings();
}

/** Reads one payment with a set's keys: Razorpay answers 200 to good keys and 401 to bad ones. */
export async function testKeys(set: GatewaySet) {
  const s = await GatewaySettingsModel.findById('razorpay').lean();
  const k = s?.[set];
  if (!k || !complete(k)) throw AppError.validation(`No ${set} keys yet`);
  const auth = Buffer.from(`${k.keyId ?? ''}:${open(k.secretSealed ?? '', sealKey())}`).toString('base64');
  try {
    const res = await fetch(`${env.RAZORPAY_BASE_URL ?? 'https://api.razorpay.com'}/v1/payments?count=1`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return { ok: true, message: `Razorpay accepted the ${set} keys` };
    return { ok: false, message: res.status === 401 ? `Razorpay refused the ${set} keys` : `Razorpay said ${String(res.status)}` };
  } catch {
    return { ok: false, message: 'Razorpay could not be reached' };
  }
}
