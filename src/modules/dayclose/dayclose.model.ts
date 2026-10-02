import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// One close per IST day (PLAN §35.3): the server's own cash maths at closing time, and what was counted.
const dayCloseSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    fy: { type: String, required: true },
    day: { type: String, required: true },
    dayStart: { type: Date, required: true },
    opening: { type: Number, required: true },
    cashSales: { type: Number, required: true },
    collected: { type: Number, required: true, default: 0 },
    advances: { type: Number, required: true },
    refunds: { type: Number, required: true },
    orderRefunds: { type: Number, required: true },
    advanceBack: { type: Number, required: true },
    cancelled: { type: Number, required: true },
    suppliers: { type: Number, required: true },
    /** Drawer cash spent on expenses (B7a); closes before it have none. */
    expenses: { type: Number },
    cashIn: { type: Number, required: true },
    cashOut: { type: Number, required: true },
    expected: { type: Number, required: true },
    counted: { type: Number, required: true },
    diff: { type: Number, required: true },
    takenOut: { type: Number, required: true },
    leftInDrawer: { type: Number, required: true },
    upi: { type: Number, required: true },
    card: { type: Number, required: true },
    advanceUsed: { type: Number, required: true },
    udhaar: { type: Number, required: true, default: 0 },
    bills: { type: Number, required: true },
    // Note counts by face value in paise, when counted note by note.
    denoms: { type: Map, of: Number },
    note: { type: String, default: '' },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false },
);

dayCloseSchema.index({ shopId: 1, day: 1 }, { unique: true });
dayCloseSchema.index({ shopId: 1, dayStart: -1 });
dayCloseSchema.plugin(tenantScoped);

export const DayCloseModel = model('DayClose', dayCloseSchema);
export type DayClose = InferSchemaType<typeof dayCloseSchema>;
