import { z } from 'zod';
import { monthEnd } from '../../core/zod';
import { GSTIN_RE, PAN_RE, PINCODE_RE, STATES, isMobile, normalizePhone } from '../../utils/india';

const text = (label: string, max = 120) => z.string().trim().min(1, `${label} is required`).max(max);
const optionalText = (max = 120) => z.string().trim().max(max).optional().transform((v) => v || undefined);

export const phone = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      const n = normalizePhone(v);
      if (!n) ctx.addIssue({ code: 'custom', message: `${label} needs 10 digits, like 98300 12345` });
      return n ?? '';
    });

export const mobile = (label: string) =>
  phone(label).refine((v) => v === '' || isMobile(v), `${label} should be a mobile number`);

const upper = (re: RegExp, message: string) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .optional()
    .transform((v) => v || undefined)
    .refine((v) => v === undefined || re.test(v), message);

const address = z
  .object({
    line1: text('Address', 200),
    line2: optionalText(200),
    city: text('City', 80),
    state: z.enum(STATES.map((s) => s.name) as [string, ...string[]], 'Choose your state'),
    pincode: z.string().trim().regex(PINCODE_RE, 'Pincode has 6 digits'),
  })
  .strict();

const shopFields = {
  name: text('Shop name'),
  address,
  phone: phone('Shop phone'),
  email: z.email('Enter a valid email address').trim().toLowerCase().optional().or(z.literal('').transform(() => undefined)),
  drugLicenseNumber: text('Drug licence number', 60),
  drugLicenseExpiry: monthEnd.refine((d) => d.getTime() > Date.now(), 'This licence has already expired'),
  gstin: upper(GSTIN_RE, 'GSTIN looks wrong — 15 characters, like 19ABCDE1234F1Z5'),
  pan: upper(PAN_RE, 'PAN looks wrong — 10 characters, like ABCDE1234F'),
  fssai: optionalText(20),
};

const gstinMatchesState = (s: { gstin?: string; address: { state: string } }) =>
  !s.gstin || STATES.find((x) => x.name === s.address.state)?.code === s.gstin.slice(0, 2);
const gstinMessage = { message: 'The GSTIN belongs to a different state than the address', path: ['gstin'] };

export const createShopSchema = z
  .object({
    owner: z.object({ name: text('Your name', 80), phone: mobile('Your phone') }).strict(),
    shop: z
      .object({ ...shopFields, pricingMode: z.enum(['MRP_INCLUSIVE', 'EXCLUSIVE']).default('MRP_INCLUSIVE') })
      .strict()
      .refine(gstinMatchesState, gstinMessage),
    termsVersion: z.string().min(1),
    agree: z.literal(true, 'Please agree to the Terms to start'),
    /** D80: optional; empty = none. */
    referralCode: z.string().trim().max(20).optional(),
  })
  .strict();

export const updateShopSchema = z
  .object({ ...shopFields, legalName: text('Legal name'), version: z.number().int().nonnegative() })
  .strict()
  .refine(gstinMatchesState, gstinMessage);

export type CreateShopInput = z.infer<typeof createShopSchema>;
export type UpdateShopInput = z.infer<typeof updateShopSchema>;
