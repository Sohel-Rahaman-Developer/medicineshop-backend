import { z } from 'zod';
import { LIMIT, objectId } from '../../core/zod';
import { ALL_UNITS, UNIT_TYPES, unitsProblem } from '../../utils/units';
import { STORAGE_TYPES } from '../racks/rack.model';
import { GST_RATES, SCHEDULE_TYPES } from './product.model';

const MAX_QTY = 10_000_000;
const optional = (max: number) => z.string().trim().max(max).default('');

export const rackCode = z
  .string()
  .trim()
  .toUpperCase()
  .max(12, 'Rack code is at most 12 characters')
  .refine((v) => v === '' || /^[A-Z0-9][A-Z0-9-]*$/.test(v), 'Use letters, numbers and dashes, like A-2-1');

export const unitsSchema = z
  .object({
    type: z.enum(UNIT_TYPES),
    base: z.enum(ALL_UNITS),
    sale: z.enum(ALL_UNITS),
    salePack: z.number().int().min(1).max(10_000),
    purchase: z.enum(ALL_UNITS),
    purchasePack: z.number().int().min(1).max(10_000),
    allowLooseSale: z.boolean(),
  })
  .strict()
  .superRefine((u, ctx) => {
    const problem = unitsProblem(u);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const fields = {
  name: z.string().trim().min(2, 'Give the product a name').max(120),
  company: optional(80),
  salt: optional(120),
  strength: optional(40),
  categoryId: objectId,
  scheduleType: z.enum(SCHEDULE_TYPES),
  storageType: z.enum(STORAGE_TYPES),
  hsnCode: z.string().trim().refine((v) => v === '' || /^\d{4,8}$/.test(v), 'HSN has 4 to 8 digits').default(''),
  gstRate: z.union(GST_RATES.map((r) => z.literal(r)), 'GST must be 0, 5, 12, 18, 28 or 40'),
  barcode: z.string().trim().refine((v) => v === '' || /^[A-Za-z0-9-]{4,32}$/.test(v), 'Barcode has 4 to 32 letters or digits').default(''),
  units: unitsSchema,
  packSize: optional(40),
  noExpiry: z.boolean().default(false),
  defaultRack: rackCode.default(''),
  reorderLevel: z.number().int().min(0).max(MAX_QTY),
  reorderQuantity: z.number().int().min(0).max(MAX_QTY),
  /** Data URL to set, null to remove, missing to keep. */
  photo: z.string().max(90_000).nullable().optional(),
};

export const createProductSchema = z.object(fields).strict();
export const updateProductSchema = z.object({ ...fields, version: z.number().int().nonnegative() }).strict();
export const activeSchema = z.object({ isActive: z.boolean(), version: z.number().int().nonnegative() }).strict();

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listQuerySchema = z
  .object({
    q: z.string().trim().max(60).default(''),
    categoryId: objectId.optional(),
    schedule: z.enum(SCHEDULE_TYPES).optional(),
    storage: z.enum(STORAGE_TYPES).optional(),
    rack: rackCode.optional(),
    company: z.string().trim().max(80).optional(),
    status: z.enum(['ok', 'low', 'out', 'inactive', 'h1']).optional(),
    expiring: flag.optional(),
    sort: z.enum(['name', 'expiry', 'value']).default('name'),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();

export type UnitsBody = z.infer<typeof unitsSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
