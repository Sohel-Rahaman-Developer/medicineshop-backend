import { z } from 'zod';

/** A GST rate: 0–100 %, up to 2 decimals (D62). Products also check it is in the shop's list. */
export const taxRate = z.number('GST must be a number').min(0, 'GST can’t be negative').max(100, 'GST is at most 100 %').multipleOf(0.01, 'GST has at most 2 decimals');

export const taxSettingsSchema = z
  .object({
    rates: z
      .array(z.object({ name: z.string().trim().min(1, 'Give it a name').max(40, 'At most 40 letters'), rate: taxRate }).strict())
      .min(1, 'Keep at least one rate')
      .max(20, 'At most 20 rates')
      .refine((v) => new Set(v.map((r) => r.rate)).size === v.length, 'The same rate twice')
      .refine((v) => new Set(v.map((r) => r.name.toLowerCase())).size === v.length, 'The same name twice'),
    defaultGstRate: taxRate,
    showHsnOnBill: z.boolean(),
  })
  .strict()
  .refine((v) => v.rates.some((r) => r.rate === v.defaultGstRate), { message: 'The default must be one of the rates', path: ['defaultGstRate'] });
export type TaxSettingsInput = z.infer<typeof taxSettingsSchema>;
