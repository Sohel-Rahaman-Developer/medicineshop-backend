import { Schema, model, type InferSchemaType } from 'mongoose';
import { tenantScoped } from '../../core/tenant-scope';

// D78: reading a supplier's bill with Claude, paid in coins. Settings, reads and coin orders are platform-side (the
// admin lists them across shops, every shop-facing query filters by shopId); the wallet and its ledger are per shop.

/** Models the admin can pick, with Anthropic's list price in US$ per million tokens (input / output). */
export const AI_MODELS = {
  'claude-opus-5-5': { name: 'Claude Opus 5.5', input: 4, output: 20 },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', input: 2, output: 10 },
  'claude-fable-5-1': { name: 'Claude Fable 5.1', input: 10, output: 50 },
} as const;
export type AiModelId = keyof typeof AI_MODELS;
export const AI_MODEL_IDS = Object.keys(AI_MODELS) as [AiModelId, ...AiModelId[]];
export const AI_EFFORTS = ['low', 'medium', 'high'] as const;

const packSchema = new Schema({ code: String, name: String, coins: Number, price: Number }, { _id: false });

const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'ai' },
    enabled: { type: Boolean, required: true, default: false },
    /** AES-256-GCM sealed Anthropic API key; only the last 4 characters ever leave the server. */
    keySealed: { type: String },
    keyLast4: { type: String },
    keySetAt: { type: Date },
    keySetBy: { type: String },
    model: { type: String, enum: AI_MODEL_IDS, required: true, default: 'claude-opus-5-5' },
    effort: { type: String, enum: AI_EFFORTS, required: true, default: 'low' },
    coinsPerPage: { type: Number, required: true, default: 1 },
    maxPages: { type: Number, required: true, default: 10 },
    /** Rupees for one US dollar, for the real cost of each read. */
    usdInr: { type: Number, required: true, default: 88 },
    /** Paise, GST included. */
    packs: { type: [packSchema], default: undefined },
    updatedBy: { type: String },
  },
  { timestamps: true, versionKey: false },
);
export const AiSettingsModel = model('AiSettings', settingsSchema);

export const DEFAULT_PACKS = [
  { code: 'c25', name: 'Starter', coins: 25, price: 29_900 },
  { code: 'c100', name: 'Shop', coins: 100, price: 99_900 },
  { code: 'c500', name: 'Busy shop', coins: 500, price: 449_900 },
];

const walletSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, unique: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false },
);
walletSchema.plugin(tenantScoped);
export const CoinWalletModel = model('CoinWallet', walletSchema);

export const COIN_KINDS = ['purchase', 'grant', 'read', 'refund'] as const;
export type CoinKind = (typeof COIN_KINDS)[number];

// Append-only: every coin in or out, with the balance after it.
const entrySchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    kind: { type: String, enum: COIN_KINDS, required: true },
    coins: { type: Number, required: true },
    balance: { type: Number, required: true },
    text: { type: String, required: true },
    /** The coin order, AI read or admin action it came from. */
    ref: { type: String },
    byName: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
entrySchema.index({ shopId: 1, createdAt: -1 });
entrySchema.plugin(tenantScoped);
export const CoinEntryModel = model('CoinEntry', entrySchema);

const readSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    shopName: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, required: true },
    fileName: { type: String, required: true },
    fileType: { type: String, enum: ['pdf', 'image', 'docx'], required: true },
    pages: { type: Number, required: true },
    coins: { type: Number, required: true },
    model: { type: String, required: true },
    status: { type: String, enum: ['running', 'done', 'failed'], required: true, default: 'running' },
    /** Coins went back to the wallet (the read failed or found no lines). */
    refunded: { type: Boolean, required: true, default: false },
    error: { type: String },
    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    /** What Anthropic charges for this read, in paise at the settings' dollar rate. */
    costPaise: { type: Number, required: true, default: 0 },
    lines: { type: Number, required: true, default: 0 },
    ms: { type: Number },
  },
  { timestamps: true, versionKey: false },
);
readSchema.index({ shopId: 1, createdAt: -1 });
readSchema.index({ createdAt: -1, _id: -1 });
export const AiReadModel = model('AiRead', readSchema);
export type AiRead = InferSchemaType<typeof readSchema>;

const partySchema = new Schema({ name: String, address: String, gstin: String, state: String, stateCode: String }, { _id: false });

const orderSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    packCode: { type: String, required: true },
    packName: { type: String, required: true },
    coins: { type: Number, required: true },
    /** Snapshot at order time, GST included; `gst` is the 18% inside it. */
    amount: { type: Number, required: true },
    gst: { type: Number, required: true },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String },
    method: { type: String },
    status: { type: String, enum: ['created', 'paid', 'failed'], required: true, default: 'created' },
    failureReason: { type: String },
    invoiceNumber: { type: String },
    invoiceFrom: { type: partySchema },
    invoiceTo: { type: partySchema },
    source: { type: String, enum: ['razorpay', 'test'], required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
    paidAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);
orderSchema.index({ shopId: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1, _id: -1 });
orderSchema.index({ razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } });
export const CoinOrderModel = model('CoinOrder', orderSchema);
