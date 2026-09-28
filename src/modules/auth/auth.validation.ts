import { z } from 'zod';

/**
 * `client` decides where the refresh token goes:
 *   web    → httpOnly cookie (JavaScript cannot touch it — safe against XSS)
 *   native → response body (stored in Expo SecureStore; cookies are not
 *            reliable on mobile)
 */
const client = z.enum(['web', 'native']).default('web');

export const requestOtpSchema = z.object({
  email: z.email('Enter a valid email address').toLowerCase().trim(),
});

export const verifyOtpSchema = z.object({
  email: z.email('Enter a valid email address').toLowerCase().trim(),
  otp: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'The code is digits only'),
  /** "Keep me signed in on this device" — on by default, since this is a shop counter. */
  rememberMe: z.boolean().default(true),
  deviceInfo: z.string().max(200).optional(),
  client,
});

export const refreshSchema = z.object({
  /** Optional in the body because the web client sends it as a cookie. */
  refreshToken: z.string().min(1).optional(),
  client,
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
  /** Sign out everywhere — for the "someone else used my phone" case. */
  allDevices: z.boolean().default(false),
});

export const sessionIdSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid session id'),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
