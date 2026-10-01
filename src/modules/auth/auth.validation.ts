import { z } from 'zod';
import { mobile } from '../shops/shops.validation';

// Every body schema is .strict(): unknown keys are rejected, never silently stored.

export const requestOtpSchema = z
  .object({
    email: z.email('Enter a valid email address').toLowerCase().trim(),
  })
  .strict();

export const verifyOtpSchema = z
  .object({
    email: z.email('Enter a valid email address').toLowerCase().trim(),
    otp: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, 'The code is digits only'),
    /** "Keep me signed in on this device" — on by default, since this is a shop counter. */
    rememberMe: z.boolean().default(true),
    deviceInfo: z.string().trim().max(200).optional(),
  })
  .strict();

/** The refresh token comes from its cookie; the body carries nothing. */
export const emptyBodySchema = z.object({}).strict();

export const logoutSchema = z
  .object({
    /** Sign out everywhere — for the "someone else used my phone" case. */
    allDevices: z.boolean().default(false),
  })
  .strict();

export const sessionIdSchema = z
  .object({
    id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid session id'),
  })
  .strict();

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1, 'Your name is required').max(80),
    phone: mobile('Your phone').optional(),
  })
  .strict();

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
