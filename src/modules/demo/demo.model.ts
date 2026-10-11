import { Schema, model, type InferSchemaType } from 'mongoose';

/** The marketing team's sign-in; its code is set in the admin console, never sent by email. */
export const DEMO_EMAIL = 'demo@medbox24.in';
/** The demo shop's staff: bills carry their names; nobody can sign in as them. */
export const DEMO_STAFF = [
  { email: 'demo.manager@medbox24.in', name: 'Priya Das', role: 'manager', designation: 'Manager' },
  { email: 'demo.cashier@medbox24.in', name: 'Sunita Roy', role: 'cashier', designation: 'Cashier' },
  { email: 'demo.stock@medbox24.in', name: 'Ravi Kumar', role: 'stockKeeper', designation: 'Stock keeper' },
] as const;
const ALL = new Set<string>([DEMO_EMAIL, ...DEMO_STAFF.map((s) => s.email)]);
export const isDemoEmail = (email: string) => ALL.has(email.toLowerCase().trim());

const jobSchema = new Schema(
  {
    kind: { type: String, enum: ['create', 'reset', 'nightly', 'topup'], required: true },
    state: { type: String, enum: ['running', 'done', 'failed'], required: true },
    by: { type: String, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    done: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    error: { type: String },
  },
  { _id: false },
);

// One document: the demo shop, its sign-in code (bcrypt) and the job that fills it.
const demoSchema = new Schema(
  {
    _id: { type: String, default: 'demo' },
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop' },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    codeHash: { type: String },
    codeSetAt: { type: Date },
    codeSetBy: { type: String },
    fails: [{ type: Date }],
    lockedUntil: { type: Date },
    /** Trading is made up to this moment; the scheduler adds what has happened since. */
    filledTo: { type: Date },
    resetAt: { type: Date },
    busyUntil: { type: Date },
    job: { type: jobSchema },
  },
  { timestamps: true, versionKey: false },
);

export const DemoModel = model('Demo', demoSchema);
export type Demo = InferSchemaType<typeof demoSchema>;
