import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';
import { EXPENSE_MODES } from '../expenses/expense.model';

export const PAY_KINDS = ['month', 'day'] as const;
export type PayKind = (typeof PAY_KINDS)[number];
/** Present (work day) and Off (weekly off) are the default and never stored. */
export const MARKS = ['absent', 'half', 'leave', 'extra'] as const;
export type Mark = (typeof MARKS)[number];
export const DAY_BASES = ['thirty', 'month'] as const;
export type DayBasis = (typeof DAY_BASES)[number];

// D114: anyone the shop pays — with an app login or without (helper, delivery boy).
const employeeSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    /** Their app login in this shop, when they have one (Staff → Payroll). */
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    phone: { type: String, default: '', trim: true },
    /** Payslips go here when the salary is paid. */
    email: { type: String, default: '', trim: true, lowercase: true },
    job: { type: String, default: '', trim: true },
    payKind: { type: String, enum: PAY_KINDS, required: true },
    /** Paise a month, or a day for day wages. */
    pay: { type: Number, required: true },
    /** 0 = Sunday … 6 = Saturday. */
    weeklyOff: { type: [Number], default: [] },
    /** Paid days off a month; they cover absent days first. */
    paidLeaves: { type: Number, default: 0 },
    /** Paise for a day worked on a weekly off; unset = the day rate. */
    extraRate: { type: Number },
    pf: { type: Boolean, default: false },
    uan: { type: String, default: '', trim: true },
    joinedOn: { type: Date, required: true },
    leftOn: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
employeeSchema.index({ shopId: 1, name: 1 });
employeeSchema.index({ shopId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } });
employeeSchema.plugin(tenantScoped);
export const EmployeeModel = model('Employee', employeeSchema);
export type Employee = InferSchemaType<typeof employeeSchema> & { _id: Types.ObjectId };

const attendanceSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    /** "YYYY-MM-DD", IST. */
    day: { type: String, required: true },
    mark: { type: String, enum: MARKS, required: true },
    byName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
attendanceSchema.index({ shopId: 1, employeeId: 1, day: 1 }, { unique: true });
attendanceSchema.index({ shopId: 1, day: 1 });
attendanceSchema.plugin(tenantScoped);
export const AttendanceModel = model('Attendance', attendanceSchema);

export const ENTRY_KINDS = ['advance', 'bonus', 'salary', 'pf'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

// Money to or for a person. Each one paid out is an expense (source payroll); removing one removes its expense.
const entrySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    kind: { type: String, enum: ENTRY_KINDS, required: true },
    /** Unset for a PF deposit (the whole shop's month). */
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    employeeName: { type: String, default: '' },
    /** "YYYY-MM": the month a salary, bonus or PF deposit is for. */
    month: { type: String },
    /** 00:00 IST of the day money moved. */
    date: { type: Date, required: true },
    amount: { type: Number, required: true },
    /** Bonus: false = added to the month's salary (no expense of its own). */
    paidNow: { type: Boolean, default: true },
    paymentMode: { type: String, enum: EXPENSE_MODES },
    fromDrawer: { type: Boolean, default: false },
    note: { type: String, default: '', trim: true },
    reference: { type: String, default: '', trim: true },
    /** Salary: the payslip emailed, last time. */
    mailedTo: { type: String },
    mailedAt: { type: Date },
    expenseId: { type: Schema.Types.ObjectId, ref: 'Expense' },
    /** Salary: what it was worked out from, as shown when paid. */
    advanceCut: { type: Number, default: 0 },
    pfEmployee: { type: Number, default: 0 },
    pfShop: { type: Number, default: 0 },
    calc: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['active', 'removed'], required: true, default: 'active' },
    removeReason: { type: String },
    removedBy: { type: String },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
entrySchema.index({ shopId: 1, employeeId: 1, kind: 1, status: 1 });
entrySchema.index({ shopId: 1, month: 1, kind: 1, status: 1 });
// One salary per person per month.
entrySchema.index({ shopId: 1, employeeId: 1, month: 1 }, { unique: true, partialFilterExpression: { kind: 'salary', status: 'active' } });
entrySchema.plugin(tenantScoped);
export const PayEntryModel = model('PayEntry', entrySchema);
export type PayEntry = InferSchemaType<typeof entrySchema> & { _id: Types.ObjectId; createdAt?: Date };

const settingSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    /** A day's pay: the month ÷ 30, or ÷ the days in that month. */
    dayBasis: { type: String, enum: DAY_BASES, default: 'thirty' },
  },
  { timestamps: true, versionKey: false },
);
settingSchema.index({ shopId: 1 }, { unique: true });
settingSchema.plugin(tenantScoped);
export const PayrollSettingModel = model('PayrollSetting', settingSchema);
