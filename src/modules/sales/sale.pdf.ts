import PDFDocument from 'pdfkit';
import qrcode from 'qrcode-generator';
import { BOLD, FONT, dayTime, mmyy, rupees } from '../../core/export';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { ShopModel } from '../shops/shop.model';
import { hsnSummary, qrText } from './sale.domain';
import { forPdf } from './sales.service';

const qtyLabel = (base: number, pack: number, sale: string, baseUnit: string) => {
  if (pack <= 1) return `${String(base)} ${sale}`;
  const full = Math.floor(base / pack);
  const loose = base % pack;
  return [full ? `${String(full)} ${sale}` : '', loose ? `${String(loose)} ${baseUnit}` : ''].filter(Boolean).join(' + ');
};

type Total = [label: string, value: string, bold: boolean];

/** A5 tax invoice — the sandbox exporter.invoice layout, with the bill QR (PLAN §14, §35.7). */
export async function billPdf(t: TenantContext, userId: string, id: string) {
  const s = await forPdf(t, userId, id);
  const shop = await ShopModel.findById(t.shopId).select('name address phone gstin drugLicenseNumber settings.tax.showHsnOnBill').lean();
  const doc = new PDFDocument({ size: 'A5', margin: 24, bufferPages: true, info: { Title: `Bill ${s.billNumber}`, Producer: 'MedShop' } });
  doc.registerFont('r', FONT);
  doc.registerFont('b', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => { resolve(Buffer.concat(chunks)); }));
  const left = 24;
  const width = doc.page.width - 48;
  const bottom = () => doc.page.height - 40;

  doc.font('b').fontSize(12).fillColor('#0b3b43').text(shop?.name ?? 'MedShop', left, 24, { width: width - 120 });
  const a = shop?.address;
  const addr = [a?.line1, a?.line2, a ? `${a.city} ${a.pincode}` : '', shop?.phone].filter(Boolean).join(', ');
  doc.font('r').fontSize(7).fillColor('#555').text(addr, { width: width - 120 });
  doc.text([shop?.gstin ? `GSTIN ${shop.gstin}` : '', shop ? `DL ${shop.drugLicenseNumber}` : ''].filter(Boolean).join(' · '), { width: width - 120 });
  const headEnd = doc.y;
  doc.font('b').fontSize(10).fillColor(s.status === 'cancelled' ? '#b42318' : '#000').text(s.status === 'cancelled' ? 'CANCELLED' : 'TAX INVOICE', left + width - 120, 24, { width: 120, align: 'right' });
  doc.font('r').fontSize(7.5).fillColor('#000').text(s.billNumber, { width: 120, align: 'right' }).text(dayTime(s.billDate), { width: 120, align: 'right' });
  doc.y = Math.max(doc.y, headEnd) + 8;
  doc.font('b').fontSize(8).text(`Bill to: ${s.customerName}${s.customerPhone ? ` · ${s.customerPhone}` : ''}`, left, doc.y, { width });
  if (s.doctorName || s.patientName) doc.font('r').text(`Doctor: ${s.doctorName || '—'} · Patient: ${s.patientName || '—'}${s.rxNumber ? ` · Rx ${s.rxNumber}` : ''}`, { width });
  doc.moveDown(0.4);

  const cols = [
    { label: 'Item', w: 3.2, num: false },
    { label: 'Qty', w: 1.2, num: true },
    { label: 'MRP', w: 1, num: true },
    { label: 'Disc', w: 0.9, num: true },
    { label: 'GST', w: 0.6, num: true },
    { label: 'Amount', w: 1.1, num: true },
  ];
  const sum = cols.reduce((a, c) => a + c.w, 0);
  const widths = cols.map((c) => (width * c.w) / sum);
  const row = (cells: string[], head: boolean, sub?: string) => {
    doc.font(head ? 'b' : 'r').fontSize(7.5);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: (widths[i] ?? 30) - 4 }))) + (sub ? 9 : 0) + 5;
    if (doc.y + h > bottom()) doc.addPage();
    const y = doc.y;
    if (head) doc.rect(left, y, width, h).fill('#eef3f3');
    let x = left;
    cells.forEach((c, i) => {
      doc.font(head ? 'b' : 'r').fontSize(7.5).fillColor('#000').text(c, x + 2, y + 2.5, { width: (widths[i] ?? 30) - 4, align: cols[i]?.num ? 'right' : 'left' });
      x += widths[i] ?? 30;
    });
    if (sub) doc.font('r').fontSize(6.3).fillColor('#666').text(sub, left + 2, y + h - 10, { width: (widths[0] ?? 100) + (widths[1] ?? 0) });
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).stroke('#c9d3d3');
    doc.y = y + h;
  };
  row(cols.map((c) => c.label), true);
  for (const l of s.lines) {
    const rx = l.schedule === 'H1' || l.schedule === 'X' ? ` · Sch ${l.schedule}` : '';
    const hsn = shop?.settings.tax?.showHsnOnBill && l.hsn ? ` · HSN ${l.hsn}` : '';
    const disc = l.discountAmount ? rupees(l.discountAmount) : l.aboveMrpAmount ? `+${rupees(l.aboveMrpAmount)}` : '—';
    row([l.productName, qtyLabel(l.quantityInBase, l.salePack, l.unit, l.baseUnit), rupees(l.mrp), disc, `${String(l.gstRate)}%`, rupees(l.totalAmount)], false, `${l.batchNumber} · Exp ${l.expiryDate ? mmyy(l.expiryDate) : 'none'}${rx}${hsn}`);
  }

  doc.moveDown(0.5);
  if (doc.y + 110 > bottom()) doc.addPage();
  const top = doc.y;
  doc.font('b').fontSize(6.8).fillColor('#000').text('HSN · rate · taxable · CGST · SGST', left, top, { width: width / 2 - 8 });
  doc.font('r');
  for (const h of hsnSummary(s.lines)) doc.text(`${h.hsn || '—'} · ${String(h.rate)}% · ${rupees(h.taxable)} · ${rupees(h.cgst)} · ${rupees(h.sgst)}`, { width: width / 2 - 8 });
  const hsnEnd = doc.y;
  const totals: Total[] = [['Subtotal (MRP)', rupees(s.subtotal), false]];
  if (s.totalDiscount) totals.push(['Discount', rupees(-s.totalDiscount), false]);
  if (s.aboveMrpAmount) totals.push(['Above MRP', rupees(s.aboveMrpAmount), false]);
  totals.push(['Taxable', rupees(s.taxableAmount), false], ['CGST', rupees(s.cgst), false], ['SGST', rupees(s.sgst), false]);
  if (s.roundOff) totals.push(['Round off', rupees(s.roundOff), false]);
  totals.push(['TOTAL', rupees(s.grandTotal), true]);
  let ty = top;
  for (const [k, v, bold] of totals) {
    doc.font(bold ? 'b' : 'r').fontSize(bold ? 9 : 7.5).fillColor('#000').text(k, left + width / 2, ty, { width: width / 4 });
    doc.text(v, left + (width * 3) / 4, ty, { width: width / 4, align: 'right' });
    ty += bold ? 13 : 10;
  }
  doc.y = Math.max(hsnEnd, ty) + 8;
  if (doc.y + 70 > bottom()) doc.addPage();
  const y = doc.y;
  const paid = s.payments.length ? s.payments.map((p) => `${p.mode} ${rupees(p.amount)}`).join(' + ') : '—';
  doc.font('r').fontSize(7.2).fillColor('#333').text(`Paid: ${paid}`, left, y, { width: width - 80 });
  doc.text(`Billed by ${s.createdByName}. Returns as per the shop’s policy.`, { width: width - 80 });
  if (s.status === 'cancelled') doc.font('b').fillColor('#b42318').text(`Cancelled by ${s.cancelledBy ?? ''}: ${s.cancelReason ?? ''}`, { width: width - 80 });

  const q = qrcode(0, 'M');
  q.addData(qrText(s.billNumber, istIsoDay(s.billDate), s.grandTotal));
  q.make();
  const n = q.getModuleCount();
  const cell = 64 / n;
  const qx = left + width - 64;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) doc.rect(qx + c * cell, y + r * cell, cell + 0.15, cell + 0.15);
  doc.fill('#0f172a');

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('r').fontSize(6.5).fillColor('#777').text(`MedShop · page ${String(i + 1)} of ${String(range.count)}`, left, doc.page.height - 30, { width, align: 'right', lineBreak: false });
  }
  doc.end();
  return { pdf: await done, name: `Bill-${s.billNumber}` };
}
