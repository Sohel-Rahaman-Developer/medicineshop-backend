import { z } from 'zod';
import { clientRequestId, istDay, LIMIT, paise } from '../../core/zod';
import { EXPENSE_MODES } from './expense.model';

const text = (max: number) => z.string().trim().max(max, `At most ${String(max)} letters`).default('');

const fields = {
  date: istDay,
  category: z.string().trim().min(1, 'Choose a category').max(40, 'At most 40 letters'),
  description: text(200),
  amount: paise('Amount').min(1, 'Enter an amount'),
  paymentMode: z.enum(EXPENSE_MODES, 'Choose how it was paid'),
  fromDrawer: z.boolean().default(true),
  vendor: text(120),
  referenceNumber: text(60),
};

export const expenseSchema = z.object({ clientRequestId, ...fields }).strict();
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const updateExpenseSchema = z.object(fields).strict();
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const deleteExpenseSchema = z.object({ reason: z.string().trim().min(3, 'Say why (3 letters at least)').max(200) }).strict();

export const expenseListSchema = z
  .object({
    from: istDay.optional(),
    to: istDay.optional(),
    category: z.string().trim().max(40).optional(),
    cursor: z.string().max(400).optional(),
    limit: LIMIT,
  })
  .strict();
export type ExpenseListQuery = z.infer<typeof expenseListSchema>;
