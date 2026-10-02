import { env } from '../../config/env';
import { setGraceDays } from '../subscription/subscription.model';
import { PlatformSettingsModel } from './admin.model';

const TTL = 60_000;
let cached: { at: number; v: { trialDays: number; trialMaxUsers: number; graceDays: number; maintenance: { on: boolean; message: string }; supportEmail: string; supportPhone: string } } | null = null;

/** Platform settings (B9) with a 1-minute cache; the grace days reach the plan status rule from here. */
export async function platform() {
  if (cached && Date.now() - cached.at < TTL) return cached.v;
  const s = await PlatformSettingsModel.findById('platform').lean();
  const v = {
    trialDays: s?.trialDays ?? env.TRIAL_DAYS,
    trialMaxUsers: s?.trialMaxUsers ?? env.TRIAL_MAX_USERS,
    graceDays: s?.graceDays ?? 7,
    maintenance: { on: s?.maintenance?.on ?? false, message: s?.maintenance?.message ?? '' },
    supportEmail: s?.supportEmail ?? '',
    supportPhone: s?.supportPhone ?? '',
  };
  setGraceDays(v.graceDays);
  cached = { at: Date.now(), v };
  return v;
}

export const forgetPlatform = () => {
  cached = null;
};
