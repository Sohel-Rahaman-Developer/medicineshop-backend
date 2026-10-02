import { z } from 'zod';
import { clientRequestId, istDay, LIMIT, objectId, paise } from '../../core/zod';
import { GSTIN_RE } from '../../utils/india';
import { PAY_MODES } from '../purchases/purchase.model';
import { phone } from '../shops/shops.validation';

const optional = (max: number) => z.string().trim().max(max).default('');

export const supplierSchema = z
  .object({
    name: z.string().trim().min(2, 'Supplier name is required').max(120),
    contactPerson: optional(80),
    phone: phone('Phone'),
    email: z.union([z.literal(''), z.email('Email looks wrong').max(160)]).default(''),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .default('')
      .refine((v) => v === '' || GSTIN_RE.test(v), 'GSTIN looks wrong — 15 characters, like 19ABCDE1234F1Z5'),
    drugLicense: optional(60),
    creditDays: z.number('Credit days must be a number').int('Credit days must be a whole number').min(0).max(365, 'At most 365 days').default(30),
    address: optional(300),
    notes: optional(500),
  })
  .strict();

export const supplierListSchema = z
  .object({ q: z.string().trim().max(60).optional(), cursor: z.string().max(400).optional(), limit: LIMIT })
  .strict();

export const ledgerQuerySchema = z.object({ from: istDay.optional(), to: istDay.optional() }).strict();

export const paymentSchema = z
  .object({
    clientRequestId,
    amount: paise('Amount', 1_000_000_000).min(1, 'Enter an amount'),
    mode: z.enum(PAY_MODES, 'Choose how you paid'),
    fromDrawer: z.boolean().default(true),
    reference: z.string().trim().max(60).default(''),
    notes: z.string().trim().max(300).default(''),
  })
  .strict();

export type SupplierInput = z.infer<typeof supplierSchema>;
export type SupplierListQuery = z.infer<typeof supplierListSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export const supplierIdQuery = z.object({ supplierId: objectId }).strict();
