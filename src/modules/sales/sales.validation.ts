import { z } from 'zod';
import { clientRequestId, istDay, LIMIT, objectId, paise } from '../../core/zod';
import { ALL_UNITS } from '../../utils/units';
import { phone } from '../shops/shops.validation';
import { REFUND_MODES } from './sale-return.model';
import { SALE_PAY_MODES } from './sale.model';

const discount = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pct'), value: z.number('Discount must be a number').min(0, 'Discount can’t be negative').max(100, 'A discount can’t be more than 100%').multipleOf(0.01, 'Discount has at most 2 decimals') }).strict(),
  z.object({ type: z.literal('flat'), value: paise('Discount') }).strict(),
]);

const itemSchema = z
  .object({
    productId: objectId,
    quantity: z.number('Quantity must be a number').int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(100_000, 'Quantity is too large'),
    unit: z.enum(ALL_UNITS as [string, ...string[]], 'Choose a unit'),
    /** A batch the cashier picked by hand; FEFO otherwise. */
    batchId: objectId.optional(),
    /** D56: the whole line's typed amount in paise — any price, never negative. */
    price: paise('Price').nullable().optional(),
    discount: discount.nullable().optional(),
  })
  .strict()
  .refine((v) => v.price === undefined || v.price === null || !v.discount, { message: 'A typed price already includes the discount', path: ['discount'] });

const text = (label: string, max: number) => z.string().trim().max(max, `${label} is at most ${String(max)} characters`);

export const saleSchema = z
  .object({
    clientRequestId,
    items: z.array(itemSchema).min(1, 'Add at least one item').max(100, 'At most 100 lines in one bill'),
    billDiscount: discount.nullable().optional(),
    customer: z.object({ name: text('Name', 80).default(''), phone: z.union([phone('Phone'), z.literal('')]).default('') }).strict().optional(),
    rx: z.object({ doctorName: text('Doctor', 80).default(''), patientName: text('Patient', 80).default(''), rxNumber: text('Rx number', 40).default(''), rxDate: istDay.optional() }).strict().optional(),
    payments: z.array(z.object({ mode: z.enum(SALE_PAY_MODES, 'Choose cash, UPI or card'), amount: paise('Amount').min(1, 'Amount must be more than 0'), reference: text('Reference', 60).default('') }).strict()).max(3),
    cashReceived: paise('Cash received').optional(),
    /** What the cashier saw; a different server total means stock or prices changed meanwhile (409). */
    expectedTotal: paise('Total').optional(),
  })
  .strict();

export const saleListSchema = z
  .object({
    from: istDay.optional(),
    to: istDay.optional(),
    status: z.enum(['completed', 'partially_returned', 'returned', 'cancelled']).optional(),
    paymentMode: z.enum([...SALE_PAY_MODES, 'SPLIT']).optional(),
    userId: objectId.optional(),
    flag: z.enum(['discount', 'aboveMrp', 'belowMin']).optional(),
    q: z.string().trim().max(40).optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export const posSearchSchema = z
  .object({
    q: z.string().trim().max(60).default(''),
    /** Fresh stock for the cart's products (reload, held bill). */
    ids: z.string().max(25 * 60).transform((v) => v.split(',').filter(Boolean)).pipe(z.array(objectId).max(50)).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();
export const cancelSaleSchema = z.object({ reason: z.string().trim().min(3, 'A reason is required').max(200) }).strict();

export const saleReturnSchema = z
  .object({
    clientRequestId,
    saleId: objectId,
    /** `line` is the bill line's index; quantity is in base units (tablets, ml…). */
    items: z
      .array(
        z
          .object({
            line: z.number('Choose a line').int().min(0).max(299),
            quantity: z.number('Quantity must be a number').int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(100_000, 'Quantity is too large'),
            reason: text('Reason', 80).min(3, 'A reason is required'),
          })
          .strict(),
      )
      .min(1, 'Choose what came back')
      .max(100)
      .refine((v) => new Set(v.map((x) => x.line)).size === v.length, 'A line is in the return twice'),
    refundMode: z.enum(REFUND_MODES, 'Choose cash or credit note'),
    expectedTotal: paise('Total').optional(),
  })
  .strict();

export const returnListSchema = z
  .object({
    from: istDay.optional(),
    to: istDay.optional(),
    saleId: objectId.optional(),
    q: z.string().trim().max(40).optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export type SaleInput = z.infer<typeof saleSchema>;
export type SaleReturnInput = z.infer<typeof saleReturnSchema>;
export type ReturnListQuery = z.infer<typeof returnListSchema>;
export type SaleItem = z.infer<typeof itemSchema>;
export type SaleListQuery = z.infer<typeof saleListSchema>;
