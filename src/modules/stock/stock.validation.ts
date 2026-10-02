import { z } from 'zod';
import { clientRequestId, LIMIT, monthEnd, objectId, paise } from '../../core/zod';
import { rackCode } from '../products/products.validation';
import { MOVEMENT_TYPES } from './movement.model';

const MAX_QTY = 10_000_000;
const qty = (label: string, min = 1) =>
  z.number(`${label} must be a number`).int(`${label} must be a whole number`).min(min, min === 0 ? `${label} can’t be negative` : `${label} must be at least ${min}`).max(MAX_QTY, `${label} is too large`);
const batchNumber = z.string().trim().min(1, 'Batch number is required').max(20, 'Batch number is at most 20 characters').regex(/^[A-Za-z0-9/-]+$/, 'Use letters, numbers, / and -');
const reason = z.string().trim().min(2, 'A reason is required').max(200);

export const openingSchema = z
  .object({
    clientRequestId,
    productId: objectId,
    batchNumber,
    expiry: monthEnd,
    mfg: monthEnd.optional(),
    /** Base units. */
    quantity: qty('Quantity'),
    /** Paise per sale unit. */
    mrp: paise('MRP').min(1, 'MRP is required'),
    /** Paise per sale unit, before GST. */
    purchaseRate: paise('Purchase rate'),
    rack: rackCode.default(''),
    mrpChoice: z.enum(['merge', 'separate']).optional(),
  })
  .strict()
  .refine((v) => !v.mfg || v.mfg <= v.expiry, { message: 'Made after it expires?', path: ['mfg'] })
  .refine((v) => !v.mfg || v.mfg.getTime() <= Date.now() + 31 * 24 * 60 * 60 * 1000, { message: 'Manufacturing month is in the future', path: ['mfg'] });

const lines = <T extends z.ZodType>(line: T) =>
  z
    .array(line)
    .min(1, 'Add at least one batch')
    .max(200, 'At most 200 batches in one adjustment')
    .refine((ls) => new Set(ls.map((l) => (l as { batchId: string }).batchId)).size === ls.length, 'A batch is listed twice');

const common = { clientRequestId, reason, notes: z.string().trim().max(500).default('') };

export const adjustmentSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('PHYSICAL_COUNT'), lines: lines(z.object({ batchId: objectId, expected: qty('System quantity', 0), counted: qty('Counted', 0) }).strict()) }).strict(),
  z.object({ ...common, type: z.enum(['DAMAGE', 'EXPIRY_WRITE_OFF', 'SELF_USE']), lines: lines(z.object({ batchId: objectId, quantity: qty('Quantity') }).strict()) }).strict(),
  z.object({ ...common, type: z.literal('TRANSFER'), lines: lines(z.object({ batchId: objectId, rackTo: rackCode.refine((v) => v !== '', 'Choose a rack') }).strict()) }).strict(),
]);

export const blockSchema = z.object({ reason: z.string().trim().max(200).default('') }).strict();

const isoDate = z.coerce.date('Use a valid date');

export const movementsQuerySchema = z
  .object({
    productId: objectId.optional(),
    batchId: objectId.optional(),
    type: z.enum(MOVEMENT_TYPES).optional(),
    userId: objectId.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export const cursorQuerySchema = z.object({ cursor: z.string().max(400).optional(), limit: LIMIT }).strict();

export const expiryQuerySchema = z
  .object({ bucket: z.enum(['expired', 'd30', 'd60', 'd90']).default('expired'), cursor: z.string().max(400).optional(), limit: LIMIT })
  .strict();

export const rackBatchesQuerySchema = z.object({ rack: rackCode.refine((v) => v !== '', 'Choose a rack') }).strict();

const target = z.coerce.number().int().refine((v) => [15, 30, 45].includes(v), 'Target is 15, 30 or 45 days').default(30);
export const reorderQuerySchema = z.object({ target }).strict();
export const reorderPdfQuerySchema = z.object({ target, supplierId: objectId.optional() }).strict();

export type OpeningInput = z.infer<typeof openingSchema>;
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;
export type MovementsQuery = z.infer<typeof movementsQuerySchema>;
export type ExpiryQuery = z.infer<typeof expiryQuerySchema>;

export const idsQuerySchema = z
  .object({ ids: z.string().max(25 * 60).transform((v) => v.split(',').filter(Boolean)).pipe(z.array(objectId).min(1).max(50)) })
  .strict();
