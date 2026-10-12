import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

export const FEE_MODES = ['CASH', 'UPI', 'CARD'] as const;
export const PAYOUT_MODES = ['CASH', 'UPI', 'BANK'] as const;
export const VISIT_STATES = ['booked', 'arrived', 'seen', 'no_show', 'cancelled'] as const;

// A refund is the same line with a minus amount, so the day close and the doctor's dues read one list.
const feePaySchema = new Schema({ amount: { type: Number, required: true }, mode: { type: String, enum: FEE_MODES, required: true }, at: { type: Date, required: true }, by: { type: String, required: true } }, { _id: false });

const patientSchema = new Schema({ name: { type: String, required: true }, nameLower: { type: String, required: true }, age: { type: Number, default: null }, gender: { type: String, enum: ['', 'female', 'male', 'other'], default: '' } }, { _id: false });

// D90: a token in one doctor's sitting on one IST day.
const appointmentSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    clientRequestId: { type: String, required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    doctorName: { type: String, required: true },
    day: { type: String, required: true },
    start: { type: String, required: true },
    end: { type: String, required: true },
    token: { type: Number, required: true },
    patient: { type: patientSchema, required: true },
    phone: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    kind: { type: String, enum: ['new', 'followup'], required: true },
    followUpOf: { type: Schema.Types.ObjectId, default: null },
    fee: { type: Number, required: true },
    /** The shop's share of the fee, fixed when booked (doctor's commission setting then). */
    commission: { type: Number, required: true, default: 0 },
    paid: { type: Number, required: true, default: 0 },
    payments: { type: [feePaySchema], default: [] },
    status: { type: String, enum: VISIT_STATES, required: true, default: 'booked' },
    arrivedAt: { type: Date },
    seenAt: { type: Date },
    cancelReason: { type: String },
    cancelledBy: { type: String },
    cancelledAt: { type: Date },
    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
appointmentSchema.index({ shopId: 1, doctorId: 1, day: 1, start: 1, token: 1 }, { unique: true });
appointmentSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
appointmentSchema.index({ shopId: 1, day: 1 });
appointmentSchema.index({ shopId: 1, phone: 1, day: -1 });
appointmentSchema.index({ shopId: 1, 'payments.at': 1 });
appointmentSchema.plugin(tenantScoped);
export const AppointmentModel = model('Appointment', appointmentSchema);
export type Appointment = InferSchemaType<typeof appointmentSchema>;

// Money handed to the doctor from what the shop collected for them.
const payoutSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    doctorName: { type: String, required: true },
    amount: { type: Number, required: true },
    mode: { type: String, enum: PAYOUT_MODES, required: true },
    /** Cash taken from the counter drawer (counts in the day close). */
    fromDrawer: { type: Boolean, required: true, default: false },
    paidAt: { type: Date, required: true },
    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
payoutSchema.index({ shopId: 1, doctorId: 1, paidAt: -1 });
payoutSchema.index({ shopId: 1, paidAt: 1 });
payoutSchema.plugin(tenantScoped);
export const DoctorPayoutModel = model('DoctorPayout', payoutSchema);

// A sitting the doctor won't take on one day: no new tokens, and the booked ones are told.
const offSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    day: { type: String, required: true },
    start: { type: String, required: true },
    reason: { type: String, default: '' },
    by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
offSchema.index({ shopId: 1, doctorId: 1, day: 1, start: 1 }, { unique: true });
offSchema.plugin(tenantScoped);
export const SittingOffModel = model('SittingOff', offSchema);
