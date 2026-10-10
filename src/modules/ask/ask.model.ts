import { Schema, model, type InferSchemaType } from 'mongoose';
import { VOICES } from './lang';

// D81: one row per chat question — how it was answered and what it cost. The question's text is never stored: what
// a shop asks stays in that shop's browser.

export const ASK_ROUTES = ['free', 'unmatched', 'ai', 'off_topic', 'blocked'] as const;
export type AskRoute = (typeof ASK_ROUTES)[number];

const questionSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true },
    shopName: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    route: { type: String, enum: ASK_ROUTES, required: true },
    /** The free card shown, or why an AI question was stopped. */
    intent: { type: String },
    tools: { type: [String], default: undefined },
    voice: { type: String, enum: VOICES, required: true },
    status: { type: String, enum: ['running', 'done', 'failed'], required: true, default: 'done' },
    /** An AI question paid from the shop's free questions rather than coins. */
    free: { type: Boolean, required: true, default: false },
    coins: { type: Number, required: true, default: 0 },
    refunded: { type: Boolean, required: true, default: false },
    error: { type: String },
    model: { type: String },
    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    cacheReadTokens: { type: Number, required: true, default: 0 },
    cacheWriteTokens: { type: Number, required: true, default: 0 },
    /** What Anthropic charges for it, in paise at the settings' price and dollar rate. */
    costPaise: { type: Number, required: true, default: 0 },
    ms: { type: Number },
  },
  { timestamps: true, versionKey: false },
);
questionSchema.index({ shopId: 1, createdAt: -1 });
questionSchema.index({ createdAt: -1, _id: -1 });
export const AskQuestionModel = model('AskQuestion', questionSchema);
export type AskQuestion = InferSchemaType<typeof questionSchema>;
