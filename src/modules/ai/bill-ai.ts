import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { signal } from '../../services/monitor';
import { AppError } from '../../core/errors';
import type { TenantContext } from '../../core/middleware/tenant';
import { PdfTextError, pdfPageCount } from '../../core/pdf-text';
import { inTransaction } from '../../core/transaction';
import { docxContent, readRows } from '../purchases/bill-read';
import { previewRead } from '../purchases/bill-import';
import { SupplierModel } from '../suppliers/supplier.model';
import type { Actor } from '../user/actor';
import { aiSettings, apiKey, listPrice, priceOf, type Price } from './ai-settings';
import { AI_MODELS, AiReadModel } from './ai.model';
import { balanceOf, moveCoins } from './coins';

export const aiReadSchema = z
  .object({
    supplierId: z.string().regex(/^[a-f\d]{24}$/i, 'Choose the supplier'),
    fileName: z.string().trim().min(1).max(160),
    /** Base64 (or a data URL): PDF, photo (JPG / PNG / WebP) or Word — about 4 MB at most. */
    data: z.string().min(8).max(6_000_000, 'That file is too large — at most about 4 MB'),
  })
  .strict();
export type AiReadInput = z.infer<typeof aiReadSchema>;

// Every value as the bill prints it — the server parses numbers and checks the sums, not the model.
const lineSchema = z.object({
  qty: z.string(),
  free: z.string(),
  company: z.string(),
  pack: z.string(),
  name: z.string(),
  oldMrp: z.string(),
  mrp: z.string(),
  expiry: z.string(),
  hsn: z.string(),
  batch: z.string(),
  rate: z.string(),
  discount: z.string(),
  gst: z.string(),
  amount: z.string(),
  net: z.string(),
});
export const aiBillSchema = z.object({
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  toPay: z.string(),
  lines: z.array(lineSchema),
  notes: z.array(z.string()),
});
export type AiBill = z.infer<typeof aiBillSchema>;

const SYSTEM = `You copy Indian pharmacy supplier bills (GST tax invoices from distributors) into JSON for a shop's purchase entry.
Copy exactly what is printed. Never calculate, round, correct or guess a value; when the bill does not print something, use "".
For each item row, on every page, in order:
- qty: quantity bought (not the free quantity). If printed as "10+2", qty is "10" and free is "2".
- free: free / scheme / bonus quantity.
- company: manufacturer (Mfr / Mfg / Company column).
- pack: pack or packing as printed, e.g. "10*15", "15 TAB", "200 ML".
- name: product name as printed.
- oldMrp: an old MRP column (OMRP), if there is one. mrp: the MRP.
- expiry: as printed, e.g. "12/27" or "Dec-27".
- hsn, batch: as printed.
- rate: the purchase rate per unit (Rate / PTR / Pur. rate), not the MRP.
- discount: discount percent on the line.
- gst: total GST percent of the line (SGST + CGST, or IGST).
- amount: the line's gross value before discount and tax; net: the line's final amount.
Rows that are not items (notes, totals, "continued") go in notes as their text.
invoiceNumber and invoiceDate (as DD-MM-YYYY) from the bill's header; toPay: the final amount payable (Please Pay / Grand Total / Net Payable) as a number with two decimals.
If the file is not a supplier bill, return no lines.`;

type Kind = { type: 'pdf' } | { type: 'image'; media: 'image/jpeg' | 'image/png' | 'image/webp' } | { type: 'docx' };

function kindOf(file: Buffer): Kind | null {
  if (file.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'pdf' };
  if (file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return { type: 'image', media: 'image/jpeg' };
  if (file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image', media: 'image/png' };
  if (file.subarray(0, 4).toString('latin1') === 'RIFF' && file.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image', media: 'image/webp' };
  if (file.length > 4 && file.readUInt32LE(0) === 0x04034b50) return { type: 'docx' };
  return null;
}

type Block = Anthropic.ContentBlockParam;

function blockOf(kind: Kind, file: Buffer): Block {
  if (kind.type === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.toString('base64') } };
  if (kind.type === 'image') return { type: 'image', source: { type: 'base64', media_type: kind.media, data: file.toString('base64') } };
  const { rows, text } = docxContent(file);
  return { type: 'text', text: `The bill, from a Word file (table rows, cells split by " | "):\n${text}\n\n${rows.map((r) => r.join(' | ')).join('\n')}` };
}

/** Anthropic's charge for one read, in paise — at the admin's price for the model when one is set. */
export function costPaise(model: keyof typeof AI_MODELS, input: number, output: number, usdInr: number, price: Price = listPrice(model)) {
  return Math.round(((input * price.input + output * price.output) / 1_000_000) * usdInr * 100);
}

/** The model's answer → the same table rows every other reader produces, so one set of checks covers them all. */
export function rowsOfAi(bill: AiBill) {
  const header = ['Qty', 'Free', 'Mfr', 'Pack', 'Product Name', 'OMRP', 'MRP', 'Exp', 'HSN', 'Batch', 'Rate', 'DIS', 'GST', 'Amount', 'Net Amount'];
  const rows = bill.lines.map((l) => [l.qty, l.free, l.company, l.pack, l.name, l.oldMrp, l.mrp, l.expiry, l.hsn, l.batch, l.rate, l.discount, l.gst, l.amount, l.net]);
  const pay = Number(bill.toPay.replace(/[^\d.]/g, ''));
  const text = [`Invoice No : ${bill.invoiceNumber}`, `Invoice Date : ${bill.invoiceDate}`, pay > 0 ? `Please Pay ${pay.toFixed(2)}` : ''].join('\n');
  return readRows([header, ...rows, ...bill.notes.map((n) => ['', '', '', '', n])], text);
}

async function askClaude(kind: Kind, file: Buffer, s: { model: keyof typeof AI_MODELS; effort: 'low' | 'medium' | 'high' }, key: string) {
  const client = new Anthropic({ apiKey: key, baseURL: env.AI_BASE_URL, maxRetries: 2, timeout: 4 * 60_000 });
  const stream = client.messages.stream({
    model: s.model,
    max_tokens: 32_000,
    system: SYSTEM,
    output_config: { ...(AI_MODELS[s.model].effort ? { effort: s.effort } : {}), format: { type: 'json_schema', schema: z.toJSONSchema(aiBillSchema) } },
    messages: [{ role: 'user', content: [blockOf(kind, file), { type: 'text', text: 'Copy this bill into the JSON.' }] }],
  });
  const msg = await stream.finalMessage();
  const usage = { input: msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0), output: msg.usage.output_tokens };
  if (msg.stop_reason === 'refusal') return { usage, error: 'The AI would not read this file' };
  if (msg.stop_reason === 'max_tokens') return { usage, error: 'The bill is too long to read in one go — upload fewer pages' };
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    return { usage, bill: aiBillSchema.parse(JSON.parse(text)) };
  } catch {
    return { usage, error: 'The AI answer could not be used' };
  }
}

const FAILED = (coins: number) => `${coins === 1 ? 'Your coin is' : `Your ${String(coins)} coins are`} back`;

/** D78: read any supplier bill — PDF (scan too), a photo, or Word — with Claude, paid by the page in coins. */
export async function readWithAi(t: TenantContext, actor: Actor, input: AiReadInput) {
  const s = await aiSettings();
  const key = s.enabled ? await apiKey() : null;
  if (!key) throw AppError.forbidden('AI bill reading is off');
  const supplier = await SupplierModel.findOne({ shopId: t.shopId, _id: new Types.ObjectId(input.supplierId) }).select('name').lean();
  if (!supplier) throw AppError.notFound('Supplier not found');
  const file = Buffer.from(input.data.replace(/^data:[^,]*,/, ''), 'base64');
  const kind = kindOf(file);
  if (!kind) throw AppError.validation('Upload a PDF, a photo (JPG, PNG) or a Word file');
  let pages = 1;
  if (kind.type === 'pdf') {
    pages = await pdfPageCount(file).catch((e: unknown) => {
      throw AppError.validation(e instanceof PdfTextError && e.reason === 'password' ? 'This PDF is locked with a password — ask the supplier for one without it' : 'This PDF could not be opened — download it again and try once more');
    });
  }
  if (pages > s.maxPages) throw AppError.validation(`AI reads up to ${String(s.maxPages)} pages at a time — this PDF has ${String(pages)}`);
  const coins = pages * s.coinsPerPage;

  const read = await inTransaction(async (session) => {
    const [doc] = await AiReadModel.create([{ shopId: t.shopId, shopName: t.shopName, userId: new Types.ObjectId(actor.id), userName: actor.name, supplierId: supplier._id, supplierName: supplier.name, fileName: input.fileName, fileType: kind.type, pages, coins, model: s.model }], { session });
    if (!doc) throw AppError.internal();
    await moveCoins(t.shopId, 'read', -coins, `AI read ${input.fileName} — ${String(pages)} page${pages === 1 ? '' : 's'}`, actor.name, String(doc._id), session);
    return doc;
  });

  const started = Date.now();
  // Claims the read while it is still running, so the stuck-read sweep and this never both give the coins back.
  const giveBack = async (error: string, usage = { input: 0, output: 0 }) => {
    await inTransaction(async (session) => {
      const claimed = await AiReadModel.updateOne({ _id: read._id, status: 'running' }, { $set: { status: 'failed', refunded: true, error, inputTokens: usage.input, outputTokens: usage.output, costPaise: costPaise(s.model, usage.input, usage.output, s.usdInr, priceOf(s, s.model)), ms: Date.now() - started } }, { session });
      if (claimed.modifiedCount) await moveCoins(t.shopId, 'refund', coins, `Back: ${input.fileName} — ${error}`, actor.name, String(read._id), session);
    });
    return error;
  };

  let answer: Awaited<ReturnType<typeof askClaude>>;
  try {
    answer = await askClaude(kind, file, s, key);
  } catch (err) {
    logger.warn({ err: err instanceof Anthropic.APIError ? { status: typeof err.status === 'number' ? err.status : null, type: err.name } : String(err) }, 'AI bill read failed');
    await signal('ai_fail');
    const why = err instanceof Anthropic.AuthenticationError ? 'the AI key was refused — MedBox24 has been told' : err instanceof Anthropic.RateLimitError ? 'the AI is busy, try again in a minute' : 'the AI could not be reached';
    throw new AppError(503, 'SERVICE_UNAVAILABLE', `Could not read the bill: ${await giveBack(why)}. ${FAILED(coins)}`);
  }
  if ('error' in answer && answer.error) throw new AppError(422, 'VALIDATION_ERROR', `${await giveBack(answer.error, answer.usage)}. ${FAILED(coins)}`);
  const bill = 'bill' in answer ? answer.bill : undefined;
  const result = bill ? rowsOfAiSafe(bill) : null;
  if (!result || !result.lines.length) throw new AppError(422, 'VALIDATION_ERROR', `${await giveBack('No item lines found on this file', answer.usage)}. ${FAILED(coins)}`);

  let preview: Awaited<ReturnType<typeof previewRead>>;
  try {
    preview = await previewRead(t, input.supplierId, result);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    throw new AppError(err.status, err.code, `${await giveBack(err.message, answer.usage)}. ${FAILED(coins)}`, err.details);
  }
  await AiReadModel.updateOne({ _id: read._id, status: 'running' }, { $set: { status: 'done', lines: result.lines.length, inputTokens: answer.usage.input, outputTokens: answer.usage.output, costPaise: costPaise(s.model, answer.usage.input, answer.usage.output, s.usdInr, priceOf(s, s.model)), ms: Date.now() - started } });
  const balance = await balanceOf(t.shopId);
  return { ...preview, ai: { readId: String(read._id), pages, coins, balance } };
}

/** readRows throws when no header is found — the AI rows always carry one, but a refund must still follow a throw. */
function rowsOfAiSafe(bill: AiBill) {
  try {
    return rowsOfAi(bill);
  } catch {
    return null;
  }
}

/** Reads left "running" by a restart get their coins back (scheduler, every few minutes). */
export async function settleStuckReads(now = new Date()) {
  // Longer than a read can take (4 min × 3 tries with the SDK's retries).
  const stuck = await AiReadModel.find({ status: 'running', createdAt: { $lt: new Date(now.getTime() - 20 * 60_000) } }).lean();
  for (const r of stuck) {
    await inTransaction(async (session) => {
      const claimed = await AiReadModel.updateOne({ _id: r._id, status: 'running' }, { $set: { status: 'failed', refunded: true, error: 'Stopped before it finished' } }, { session });
      if (claimed.modifiedCount) await moveCoins(r.shopId, 'refund', r.coins, `Back: ${r.fileName} — the read stopped before it finished`, 'MedBox24', String(r._id), session);
    });
  }
  return stuck.length;
}
