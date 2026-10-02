import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const EXPENSE_MODES = ['CASH', 'UPI', 'CARD', 'BANK'] as const;
/** Suggestions only — the shop can type its own category. */
export const EXPENSE_CATEGORIES = ['Rent', 'Salary', 'Electricity', 'Staff tea', 'Delivery', 'Repairs', 'Other'];

// PLAN §21.9: what the shop spends that isn't stock. Removing keeps the row (status deleted) for the audit trail.
const expenseSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    expenseNumber: { type: String, required: true },
    /** 00:00 IST of the day it was paid. */
    date: { type: Date, required: true },
    category: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    amount: { type: Number, required: true },
    paymentMode: { type: String, enum: EXPENSE_MODES, required: true },
    /** Cash out of the counter drawer — day close counts it (PLAN §35.3). */
    fromDrawer: { type: Boolean, required: true },
    vendor: { type: String, default: '', trim: true },
    referenceNumber: { type: String, default: '', trim: true },
    status: { type: String, enum: ['active', 'deleted'], required: true, default: 'active' },
    deleteReason: { type: String },
    deletedBy: { type: String },
    deletedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

expenseSchema.index({ shopId: 1, expenseNumber: 1 }, { unique: true });
expenseSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
expenseSchema.index({ shopId: 1, status: 1, date: -1, _id: -1 });
expenseSchema.plugin(tenantScoped);

export const ExpenseModel = model('Expense', expenseSchema);
export type Expense = InferSchemaType<typeof expenseSchema>;
