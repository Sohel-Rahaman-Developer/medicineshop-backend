import { readZip } from '../../core/zip-read';
import { AppError } from '../../core/errors';

/** One bill line as read, before the shop confirms it. Money in paise, expiry "YYYY-MM". */
export interface ReadLine {
  name: string;
  company: string;
  pack: string;
  batchNumber: string;
  expiry?: string;
  mrp: number;
  oldMrp?: number;
  rate: number;
  quantity: number;
  freeQuantity: number;
  discountPercent: number;
  gstRate?: number;
  hsn: string;
  /** What the bill itself says the line comes to, to check the reading. */
  amount?: number;
  net?: number;
  checks: string[];
}

type Field = 'qty' | 'free' | 'company' | 'pack' | 'name' | 'oldMrp' | 'mrp' | 'expiry' | 'hsn' | 'batch' | 'rate' | 'discount' | 'gst' | 'sgst' | 'cgst' | 'igst' | 'amount' | 'net';

// Column titles different billing software (Marg, Busy, Tally, GoFrugal) print, squashed to letters and digits.
const TITLES: Record<string, Field> = {
  qty: 'qty', quantity: 'qty', qnty: 'qty', billqty: 'qty',
  free: 'free', fr: 'free', freeqty: 'free', sch: 'free', schqty: 'free', bonus: 'free',
  mfr: 'company', mfg: 'company', mfgr: 'company', company: 'company', manufacturer: 'company', mfgby: 'company', comp: 'company',
  pack: 'pack', packing: 'pack', pkg: 'pack', packsize: 'pack', pk: 'pack',
  product: 'name', productname: 'name', item: 'name', itemname: 'name', description: 'name', particulars: 'name', itemdescription: 'name', medicine: 'name', name: 'name',
  omrp: 'oldMrp', oldmrp: 'oldMrp',
  mrp: 'mrp', newmrp: 'mrp',
  exp: 'expiry', expiry: 'expiry', expdt: 'expiry', expdate: 'expiry', expirydate: 'expiry',
  hsn: 'hsn', hsncode: 'hsn', hsnsac: 'hsn',
  batch: 'batch', batchno: 'batch', bno: 'batch', batchnumber: 'batch', lot: 'batch',
  rate: 'rate', ptr: 'rate', purrate: 'rate', purchaserate: 'rate', netrate: 'rate',
  dis: 'discount', disc: 'discount', discount: 'discount', dispct: 'discount', discpct: 'discount', cd: 'discount', d: 'discount',
  gst: 'gst', gstpct: 'gst', tax: 'gst', taxpct: 'gst',
  sgst: 'sgst', sgstpct: 'sgst', cgst: 'cgst', cgstpct: 'cgst', igst: 'igst', igstpct: 'igst',
  amount: 'amount', amt: 'amount', value: 'amount', grossamt: 'amount', grossamount: 'amount',
  netamount: 'net', netamt: 'net', total: 'net', netvalue: 'net', nettotal: 'net',
};
const squash = (s: string) => s.toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '');

/** Which column is which, from the header row; null when the row isn't a header. */
function headerOf(row: string[]): Map<Field, number> | null {
  const map = new Map<Field, number>();
  row.forEach((cell, i) => {
    const f = TITLES[squash(cell)];
    if (f && !map.has(f)) map.set(f, i);
  });
  return map.has('name') && (map.has('qty') || map.has('mrp')) && map.size >= 3 ? map : null;
}

const money = (s: string | undefined) => {
  const t = (s ?? '').replace(/[₹,\s]/g, '');
  if (!/^\d+$|^\d+\.\d{1,3}$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};
const num = (s: string | undefined) => {
  const t = (s ?? '').replace(/[%,\s]/g, '');
  return /^\d+$|^\d+\.\d+$/.test(t) ? Number(t) : null;
};
/** "12/27", "1/28", "12-2027", "Dec-27" → "2027-12". */
export function expiryOf(s: string | undefined): string | undefined {
  const t = (s ?? '').trim().toUpperCase();
  const m = /^(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})$/.exec(t);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const w = /^([A-Z]{3})[A-Z]*\s*[/.-]?\s*(\d{2}|\d{4})$/.exec(t);
  const month = m ? Number(m[1]) : w ? months.indexOf(w[1] ?? '') + 1 : 0;
  const year = m?.[2] ?? w?.[2];
  if (!year || month < 1 || month > 12) return undefined;
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  return `${String(y)}-${String(month).padStart(2, '0')}`;
}

/** Table rows → bill lines. Rows above the header and below the last line (totals, notes) are left out and listed. */
export function linesOf(rows: string[][]): { lines: ReadLine[]; skipped: string[]; header: Field[] } {
  const at = rows.findIndex((r) => headerOf(r));
  if (at < 0) throw AppError.validation('No item table found — the bill needs a header row like Qty · Product · Batch · Exp · MRP · Rate');
  const h = headerOf(rows[at] ?? []) ?? new Map<Field, number>();
  const cell = (r: string[], f: Field) => {
    const i = h.get(f);
    return i === undefined ? undefined : (r[i] ?? '').trim();
  };
  const lines: ReadLine[] = [];
  const skipped: string[] = [];
  for (const r of rows.slice(at + 1)) {
    const name = cell(r, 'name') ?? '';
    const rawQty = cell(r, 'qty') ?? '';
    // "10+2" = 10 bought, 2 free.
    const plus = /^(\d+)\s*\+\s*(\d+)$/.exec(rawQty);
    const qty = plus ? Number(plus[1]) : num(rawQty);
    const mrp = money(cell(r, 'mrp'));
    if (!name || qty === null || !Number.isInteger(qty) || qty < 1 || mrp === null || mrp < 1) {
      const text = r.map((c) => c.trim()).filter(Boolean).join(' · ');
      if (text) skipped.push(text);
      continue;
    }
    const sgst = num(cell(r, 'sgst'));
    const cgst = num(cell(r, 'cgst'));
    const gst = num(cell(r, 'gst')) ?? num(cell(r, 'igst')) ?? (sgst !== null || cgst !== null ? (sgst ?? 0) + (cgst ?? 0) : null);
    const line: ReadLine = {
      name,
      company: cell(r, 'company') ?? '',
      pack: cell(r, 'pack') ?? '',
      batchNumber: (cell(r, 'batch') ?? '').toUpperCase(),
      expiry: expiryOf(cell(r, 'expiry')),
      mrp,
      oldMrp: money(cell(r, 'oldMrp')) ?? undefined,
      rate: money(cell(r, 'rate')) ?? 0,
      quantity: qty,
      freeQuantity: plus ? Number(plus[2]) : (num(cell(r, 'free')) ?? 0),
      discountPercent: num(cell(r, 'discount')) ?? 0,
      gstRate: gst ?? undefined,
      hsn: (cell(r, 'hsn') ?? '').replace(/\D/g, '').slice(0, 8),
      amount: money(cell(r, 'amount')) ?? undefined,
      net: money(cell(r, 'net')) ?? undefined,
      checks: [],
    };
    checkLine(line);
    lines.push(line);
  }
  return { lines, skipped, header: [...h.keys()] };
}

/** The bill's own Amount and Net columns against qty × rate, discount and GST — a misread number shows up here. */
function checkLine(l: ReadLine) {
  const gross = l.quantity * l.rate;
  if (l.amount !== undefined && l.rate && Math.abs(l.amount - gross) > l.quantity + 1) l.checks.push(`Amount on the bill ${(l.amount / 100).toFixed(2)} ≠ ${String(l.quantity)} × ${(l.rate / 100).toFixed(2)} = ${(gross / 100).toFixed(2)}`);
  if (l.net !== undefined && l.amount !== undefined && l.gstRate !== undefined) {
    const net = Math.round((l.amount * (1 - l.discountPercent / 100) * (1 + l.gstRate / 100)));
    if (Math.abs(l.net - net) > 2) l.checks.push(`Net on the bill ${(l.net / 100).toFixed(2)} ≠ ${(l.amount / 100).toFixed(2)} − ${String(l.discountPercent)}% + ${String(l.gstRate)}% GST = ${(net / 100).toFixed(2)}`);
  }
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const textOf = (xml: string) => decode([...xml.matchAll(/<w:t>([^<]*)<\/w:t>|<w:t\s[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? m[2] ?? '').join(''));

/** A Word file: every table row as cells, and the text around the tables (for the invoice number and date). */
export function docxContent(file: Buffer): { rows: string[][]; text: string } {
  let xml: string;
  try {
    const doc = readZip(file, (n) => n === 'word/document.xml').get('word/document.xml');
    if (!doc) throw new Error('missing');
    xml = doc.toString('utf8');
  } catch {
    throw AppError.validation('This Word file could not be opened — save it again as .docx and try once more');
  }
  const rows = [...xml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((tc) => textOf(tc[0]).trim()));
  const text = [...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) => textOf(p[0])).join('\n');
  return { rows, text };
}

/** Invoice number, date and the amount to pay, when the bill prints them with a label. */
export function metaOf(text: string) {
  const inv = /invoice\s*(?:no|number|#)\.?\s*[:-]?\s*([A-Z0-9][A-Z0-9/-]{1,39})/i.exec(text)?.[1];
  const d = /(?:invoice\s*date|bill\s*date|date)\s*[:-]?\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/i.exec(text);
  const year = d?.[3] ? (d[3].length === 2 ? `20${d[3]}` : d[3]) : null;
  const pay = /(?:please\s*pay|grand\s*total|net\s*payable|net\s*amount|bill\s*amount)[\s:₹Rs.-]*([\d,]+\.\d{2})/i.exec(text)?.[1];
  return {
    invoiceNumber: inv ?? null,
    invoiceDate: d && year ? `${year}-${(d[2] ?? '').padStart(2, '0')}-${(d[1] ?? '').padStart(2, '0')}` : null,
    toPay: pay ? money(pay) : null,
  };
}

/** A supplier's file → its lines. DOCX now; PDF reading follows from the shops' real bills. */
export function readBillFile(name: string, file: Buffer) {
  if (file.subarray(0, 4).toString('latin1') === '%PDF') throw AppError.validation('PDF bills are coming next — for now send the Word (.docx) file');
  if (file.readUInt32LE(0) !== 0x04034b50 || !/\.docx$/i.test(name)) throw AppError.validation('Upload the supplier’s bill as a .docx (Word) or PDF file');
  const { rows, text } = docxContent(file);
  return readRows(rows, text);
}

/** Rows from any source (Word table, or an Excel / CSV sheet read in the browser) → lines, invoice details, totals check. */
export function readRows(rows: string[][], text = '') {
  const read = linesOf(rows);
  const meta = metaOf(`${text}\n${rows.map((r) => r.join(' ')).join('\n')}`);
  const net = read.lines.reduce((s, l) => s + (l.net ?? 0), 0);
  const billCheck = meta.toPay !== null && read.lines.every((l) => l.net !== undefined) && Math.abs(Math.round(net / 100) * 100 - meta.toPay) > 100 ? `The lines come to ${(net / 100).toFixed(2)} but the bill says ${(meta.toPay / 100).toFixed(2)} — a line may be missing or misread` : null;
  return { ...read, meta, billCheck };
}
