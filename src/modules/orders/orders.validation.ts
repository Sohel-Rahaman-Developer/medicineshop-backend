import { z } from 'zod';
import { clientRequestId, istDay, LIMIT, objectId, paise } from '../../core/zod';
import { phone } from '../shops/shops.validation';
import { ADVANCE_MODES } from './order.model';

const text = (label: string, max: number) => z.string().trim().max(max, `${label} is at most ${String(max)} characters`);

const itemSchema = z
  .object({
    productId: objectId.optional(),
    /** Only when the medicine is not in the product list yet. */
    name: text('Name', 120).default(''),
    qty: z.number('Quantity must be a number').int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(10_000, 'Quantity is too large'),
  })
  .strict()
  .refine((v) => v.productId || v.name.length >= 2, { message: 'Choose a product or type its name', path: ['name'] });

export const orderSchema = z
  .object({
    clientRequestId,
    customer: z.object({ name: text('Name', 80).min(2, 'The name goes on the order slip'), phone: z.union([phone('Phone'), z.literal('')]).default('') }).strict(),
    items: z.array(itemSchema).min(1, 'Add at least one medicine').max(30, 'At most 30 lines in one order'),
    advance: paise('Advance').default(0),
    advanceMode: z.enum(ADVANCE_MODES, 'Choose cash or UPI').optional(),
    expectedBy: istDay.optional(),
    note: text('Note', 200).default(''),
    /** Short book lines this order answers (PLAN §35.2). */
    demandIds: z.array(objectId).max(30).default([]),
  })
  .strict()
  .refine((v) => !v.advance || v.advanceMode, { message: 'How was the advance paid?', path: ['advanceMode'] });

export const orderListSchema = z
  .object({
    status: z.enum(['open', 'ready', 'completed', 'cancelled']).default('open'),
    q: z.string().trim().max(40).optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export const linkItemSchema = z.object({ index: z.number().int().min(0).max(29), productId: objectId }).strict();

export const cancelOrderSchema = z
  .object({
    reason: text('Reason', 200).min(3, 'A reason is required'),
    /** Give the advance back this way… */
    refundMode: z.enum(ADVANCE_MODES).optional(),
    /** …or keep it, with a reason (Owner / Manager). */
    keepReason: text('Reason', 200).optional(),
  })
  .strict()
  .refine((v) => !(v.refundMode && v.keepReason), { message: 'Either give the advance back or keep it', path: ['keepReason'] });

export type OrderInput = z.infer<typeof orderSchema>;
export type OrderListQuery = z.infer<typeof orderListSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
