import { z } from 'zod';
import { clientRequestId, istDay, LIMIT, monthEnd, objectId, paise } from '../../core/zod';
import { ALL_UNITS } from '../../utils/units';
import { taxRate } from '../tax/tax.validation';
import { rackCode } from '../products/products.validation';
import { PAY_MODES, RETURN_REASONS } from './purchase.model';

const whole = (label: string, min: number, max = 1_000_000) =>
  z.number(`${label} must be a number`).int(`${label} must be a whole number`).min(min, min ? `${label} must be at least ${min}` : `${label} can’t be negative`).max(max, `${label} is too large`);
const batchNumber = z.string().trim().min(1, 'Batch number is required').max(20, 'Batch number is at most 20 characters').regex(/^[A-Za-z0-9/-]+$/, 'Use letters, numbers, / and -');
/** Empty only for a non-medicine: the service gives it the day's lot (D59). */
const batchOrBlank = z.union([batchNumber, z.literal('')]).default('');

export const purchaseLineObject = z
  .object({
    productId: objectId,
    batchNumber: batchOrBlank,
    expiry: monthEnd.optional(),
    mfg: monthEnd.optional(),
    quantity: whole('Quantity', 1),
    freeQuantity: whole('Free quantity', 0).default(0),
    unit: z.enum(ALL_UNITS as [string, ...string[]], 'Choose a unit'),
    /** Paise per `unit`, before GST. */
    rate: paise('Rate').min(1, 'Rate is required'),
    discountPercent: z.number('Discount must be a number').min(0, 'Discount can’t be negative').max(100, 'Discount is at most 100 %').multipleOf(0.01, 'Discount has at most 2 decimals').default(0),
    /** Paise per sale unit. */
    mrp: paise('MRP').min(1, 'MRP is required'),
    minPrice: paise('Lowest price').nullable().optional(),
    /** As on the supplier's bill — any rate (D62). */
    gstRate: taxRate,
    rack: rackCode.default(''),
    mrpChoice: z.enum(['merge', 'separate']).optional(),
  })
  .strict();
export const purchaseLineSchema = purchaseLineObject.refine((v) => !v.mfg || !v.expiry || v.mfg <= v.expiry, { message: 'Made after it expires?', path: ['mfg'] });

export const purchaseSchema = z
  .object({
    clientRequestId,
    supplierId: objectId,
    invoiceNumber: z.string().trim().min(1, 'Invoice number is required').max(40),
    invoiceDate: istDay,
    dueDate: istDay.optional(),
    lines: z.array(purchaseLineSchema).min(1, 'Add at least one line').max(300, 'At most 300 lines in one purchase'),
    payment: z
      .object({
        mode: z.enum(['CREDIT', ...PAY_MODES]).default('CREDIT'),
        amount: paise('Paid', 1_000_000_000).default(0),
        fromDrawer: z.boolean().default(true),
        reference: z.string().trim().max(60).default(''),
      })
      .strict()
      .default({ mode: 'CREDIT', amount: 0, fromDrawer: true, reference: '' }),
    notes: z.string().trim().max(500).default(''),
    /** Ignored: the server works every total out itself (SECURITY §6 B3). */
    grandTotal: z.number().optional(),
  })
  .strict()
  .refine((v) => v.invoiceDate.getTime() <= Date.now() + 24 * 60 * 60 * 1000, { message: 'Invoice date is in the future', path: ['invoiceDate'] })
  .refine((v) => !v.dueDate || v.dueDate >= v.invoiceDate, { message: 'Due date is before the invoice date', path: ['dueDate'] });

export const purchaseListSchema = z
  .object({
    supplierId: objectId.optional(),
    from: istDay.optional(),
    to: istDay.optional(),
    paymentStatus: z.enum(['paid', 'partial', 'unpaid']).optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export const rangeSchema = z.object({ from: istDay, to: istDay }).strict();

export const lineInfoSchema = z.object({ productId: objectId, supplierId: objectId.optional() }).strict();

export const cancelSchema = z.object({ reason: z.string().trim().min(3, 'A reason is required').max(200) }).strict();

export const returnSchema = z
  .object({
    clientRequestId,
    supplierId: objectId,
    purchaseId: objectId.optional(),
    reason: z.enum(RETURN_REASONS, 'Choose a reason'),
    lines: z
      .array(z.object({ batchId: objectId, quantity: whole('Quantity', 1, 10_000_000) }).strict())
      .min(1, 'Pick at least one batch')
      .max(200)
      .refine((ls) => new Set(ls.map((l) => l.batchId)).size === ls.length, 'A batch is listed twice'),
    notes: z.string().trim().max(300).default(''),
  })
  .strict();

export const returnListSchema = z
  .object({ supplierId: objectId.optional(), status: z.enum(['pending', 'settled']).optional(), cursor: z.string().max(400).optional(), limit: LIMIT })
  .strict();

export const candidatesSchema = z.object({ supplierId: objectId, purchaseId: objectId.optional() }).strict();

export const settleSchema = z.object({ creditNoteNumber: z.string().trim().min(1, 'Credit note number is required').max(40) }).strict();

export type PurchaseInput = z.infer<typeof purchaseSchema>;
export type PurchaseLineInput = z.infer<typeof purchaseLineSchema>;
export type PurchaseListQuery = z.infer<typeof purchaseListSchema>;
export type ReturnInput = z.infer<typeof returnSchema>;
export type ReturnListQuery = z.infer<typeof returnListSchema>;
