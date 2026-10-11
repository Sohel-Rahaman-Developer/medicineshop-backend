import { z } from 'zod';
import { clientRequestId, istDay, LIMIT, objectId, paise } from '../../core/zod';
import { GSTIN_RE } from '../../utils/india';
import { mobile, phone } from '../shops/shops.validation';
import { COLLECT_MODES } from './customer.model';

const text = (label: string, max: number) => z.string().trim().max(max, `${label} is at most ${String(max)} characters`);

const fields = {
  name: text('Name', 80).min(2, 'Type the customer’s name'),
  phone: mobile('Phone').refine((v) => v !== '', 'A phone number is needed — it is how the shop finds the customer'),
  email: z.union([z.email('Enter a valid email address').trim().toLowerCase(), z.literal('')]).default(''),
  dob: istDay.nullable().optional(),
  gender: z.enum(['', 'female', 'male', 'other']).default(''),
  address: text('Address', 200).default(''),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .default('')
    .refine((v) => v === '' || GSTIN_RE.test(v), 'GSTIN looks wrong — 15 characters, like 19ABCDE1234F1Z5'),
  businessName: text('Business name', 120).default(''),
  whatsappOptIn: z.boolean().default(false),
  smsOptIn: z.boolean().default(false),
  emailOptIn: z.boolean().default(false),
  creditLimit: paise('Udhaar limit').max(100_000_000, 'Udhaar limit is too large').default(0),
  chronicConditions: z.array(text('Condition', 40)).max(10).default([]),
  notes: text('Notes', 300).default(''),
};

export const customerSchema = z.object(fields).strict();
export const updateCustomerSchema = z.object({ ...fields, status: z.enum(['active', 'blocked']).default('active'), version: z.number().int().min(0) }).strict();

export const customerListSchema = z
  .object({
    q: z.string().trim().max(60).optional(),
    filter: z.enum(['all', 'udhaar', 'overLimit']).default('all'),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export const collectSchema = z
  .object({
    clientRequestId,
    amount: paise('Amount').min(1, 'Amount must be more than 0'),
    mode: z.enum(COLLECT_MODES, 'Choose cash, UPI or card'),
    reference: text('Reference', 60).default(''),
  })
  .strict();

export const doctorSchema = z
  .object({
    name: text('Name', 80).min(3, 'Type the doctor’s name'),
    specialization: text('Specialization', 60).default(''),
    registrationNumber: text('Registration number', 40).default(''),
    phone: z.union([phone('Phone'), z.literal('')]).default(''),
    clinic: text('Clinic', 120).default(''),
  })
  .strict();

export type CustomerInput = z.infer<typeof customerSchema>;

/** Udhaar page, one form: a customer found or typed new, old khata udhaar and the limit. */
export const addUdhaarSchema = z
  .object({
    clientRequestId,
    customerId: objectId.optional(),
    customer: z.object({ name: fields.name, phone: fields.phone }).strict().optional(),
    amount: paise('Old udhaar').max(100_000_000, 'Old udhaar is too large').default(0),
    since: istDay.optional(),
    creditLimit: paise('Udhaar limit').max(100_000_000, 'Udhaar limit is too large').optional(),
    note: text('Note', 120).default(''),
  })
  .strict()
  .refine((v) => Boolean(v.customerId) !== Boolean(v.customer), { message: 'Pick a customer or type a new one', path: ['customerId'] })
  .refine((v) => v.amount > 0 || v.creditLimit !== undefined, { message: 'Type the old udhaar or an udhaar limit', path: ['amount'] })
  .refine((v) => !v.since || v.since.getTime() <= Date.now(), { message: 'That day has not come yet', path: ['since'] });
export type AddUdhaarInput = z.infer<typeof addUdhaarSchema>;

export const correctOldSchema = z.object({ amount: paise('Amount').min(1, 'Amount must be more than 0'), reason: text('Reason', 200).min(3, 'Say why (3 letters at least)') }).strict();
export type CorrectOldInput = z.infer<typeof correctOldSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerListQuery = z.infer<typeof customerListSchema>;
export type CollectInput = z.infer<typeof collectSchema>;
export type DoctorInput = z.infer<typeof doctorSchema>;
