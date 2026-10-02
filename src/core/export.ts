import { createRequire } from 'node:module';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import writeXlsxFile from 'write-excel-file/node';
import type { Types } from 'mongoose';
import { ShopModel } from '../modules/shops/shop.model';

// DejaVu has the ₹ sign; PDFKit's built-in Helvetica does not.
const fontDir = `${createRequire(__filename).resolve('dejavu-fonts-ttf/package.json').replace(/package\.json$/, '')}ttf/`;
const FONT = `${fontDir}DejaVuSans.ttf`;
const BOLD = `${fontDir}DejaVuSans-Bold.ttf`;

export interface Column<T> {
  label: string;
  get: (row: T) => string | number;
  num?: boolean;
  /** Relative width; default 1. */
  w?: number;
}

/** Excel file of a list — the numbers stay numbers so the user can add them up. */
export async function xlsx<T>(columns: Column<T>[], rows: readonly T[]): Promise<Buffer> {
  const header = columns.map((c) => ({ value: c.label, fontWeight: 'bold' as const }));
  const body = rows.map((r) => columns.map((c) => ({ value: c.get(r) })));
  return writeXlsxFile([header, ...body], { columns: columns.map((c) => ({ width: Math.round(12 * (c.w ?? 1)) })) }).toBuffer();
}

export interface PdfTable<T> {
  shopId: Types.ObjectId;
  title: string;
  sub?: string;
  columns: Column<T>[];
  rows: readonly T[];
  foot?: (string | number)[];
  /** Label / value pairs printed under the table (totals). */
  summary?: [string, string][];
  landscape?: boolean;
}

/** A shop-headed table PDF (sandbox exporter.pdfTable): header on every page, page numbers at the foot. */
export async function pdfTable<T>(o: PdfTable<T>): Promise<Buffer> {
  const shop = await ShopModel.findById(o.shopId).select('name address phone gstin drugLicenseNumber').lean();
  const doc = new PDFDocument({ size: 'A4', layout: o.landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: o.title, Producer: 'MedShop' } });
  doc.registerFont('r', FONT);
  doc.registerFont('b', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => { resolve(Buffer.concat(chunks)); }));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const total = o.columns.reduce((s, c) => s + (c.w ?? 1), 0);
  const widths = o.columns.map((c) => (width * (c.w ?? 1)) / total);
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24;

  const head = () => {
    doc.font('b').fontSize(13).fillColor('#0b3b43').text(shop?.name ?? 'MedShop', left, doc.page.margins.top);
    const addr = shop ? [shop.address?.line1, shop.address?.city, shop.phone, shop.gstin ? `GSTIN ${shop.gstin}` : '', `DL ${shop.drugLicenseNumber}`].filter(Boolean).join(' · ') : '';
    doc.font('r').fontSize(8).fillColor('#555').text(addr, { width });
    doc.moveDown(0.6).font('b').fontSize(12).fillColor('#000').text(o.title, { width });
    if (o.sub) doc.font('r').fontSize(9).fillColor('#444').text(o.sub, { width });
    doc.moveDown(0.5);
  };
  const row = (cells: (string | number)[], bold: boolean, shade: boolean) => {
    doc.font(bold ? 'b' : 'r').fontSize(8.5);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c), { width: (widths[i] ?? 40) - 6 }))) + 6;
    if (doc.y + h > bottom()) {
      doc.addPage();
      head();
      row(o.columns.map((c) => c.label), true, true);
      doc.font(bold ? 'b' : 'r').fontSize(8.5);
    }
    const y = doc.y;
    if (shade) doc.rect(left, y, width, h).fill('#eef3f3');
    let x = left;
    cells.forEach((c, i) => {
      const w = widths[i] ?? 40;
      doc.fillColor('#000').text(String(c), x + 3, y + 3, { width: w - 6, align: o.columns[i]?.num ? 'right' : 'left' });
      x += w;
    });
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).stroke('#c9d3d3');
    doc.y = y + h;
  };

  head();
  row(o.columns.map((c) => c.label), true, true);
  for (const r of o.rows) row(o.columns.map((c) => c.get(r)), false, false);
  if (!o.rows.length) row(['Nothing to show', ...o.columns.slice(1).map(() => '')], false, false);
  if (o.foot) row(o.foot, true, true);
  if (o.summary) {
    doc.moveDown(0.6);
    for (const [k, v] of o.summary) {
      if (doc.y + 14 > bottom()) doc.addPage();
      const y = doc.y;
      doc.font(k.startsWith('=') ? 'b' : 'r').fontSize(9).fillColor('#000').text(k.replace(/^=\s*/, ''), left + width - 260, y, { width: 150 });
      doc.text(v, left + width - 110, y, { width: 110, align: 'right' });
      doc.y = y + 14;
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('r').fontSize(7.5).fillColor('#777').text(`MedShop · page ${String(i + 1)} of ${String(range.count)}`, left, doc.page.height - doc.page.margins.bottom - 10, { width, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';

export function sendFile(res: Response, data: Buffer, name: string, kind: 'pdf' | 'xlsx') {
  res.set({
    'Content-Type': kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${safeName(name)}.${kind}"`,
    'Content-Length': String(data.length),
  });
  res.send(data);
}

/** ₹1,234.50 for PDF cells. */
export const rupees = (paise: number) => `${paise < 0 ? '−' : ''}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const IST = 5.5 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 02 Oct 2026, by the IST calendar. */
export function day(at: Date) {
  if (at.getUTCFullYear() >= 9999) return '—';
  const d = new Date(at.getTime() + IST);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear())}`;
}
/** 08/27 — pack expiry. */
export function mmyy(at: Date) {
  if (at.getUTCFullYear() >= 9999) return '—';
  const d = new Date(at.getTime() + IST);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

/** 02 Oct 2026 14:05 IST. */
export function dayTime(at: Date) {
  const d = new Date(at.getTime() + IST);
  return `${day(at)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
