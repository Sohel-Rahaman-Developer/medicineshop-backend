import PDFDocument from 'pdfkit';
import qrcode from 'qrcode-generator';
import { BOLD, FONT, dayTime, mmyy, rupees } from '../../core/export';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { ShopModel } from '../shops/shop.model';
import * as returns from './sale-returns.service';
import { hsnSummary, packLabel, qrText } from './sale.domain';
import { forPdf } from './sales.service';

type Total = [label: string, value: string, bold: boolean];
interface Row {
  name: string;
  qty: string;
  mrp: number;
  disc: string;
  gstRate: number;
  amount: number;
  sub: string;
}
interface Paper {
  title: string;
  danger: boolean;
  number: string;
  at: Date;
  head: string[];
  rows: Row[];
  hsn: ReturnType<typeof hsnSummary>;
  totals: Total[];
  foot: string[];
  alert?: string;
  qr?: string;
}

/** A5 tax invoice / credit note — the sandbox exporter.invoice layout (PLAN §14, §15, §35.7). */
async function paper(t: TenantContext, p: Paper) {
  const shop = await ShopModel.findById(t.shopId).select('name address phone gstin drugLicenseNumber').lean();
  const doc = new PDFDocument({ size: 'A5', margin: 24, bufferPages: true, info: { Title: `${p.title} ${p.number}`, Producer: 'MedShop' } });
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
  doc.font('b').fontSize(10).fillColor(p.danger ? '#b42318' : '#000').text(p.title, left + width - 120, 24, { width: 120, align: 'right' });
  doc.font('r').fontSize(7.5).fillColor('#000').text(p.number, { width: 120, align: 'right' }).text(dayTime(p.at), { width: 120, align: 'right' });
  doc.y = Math.max(doc.y, headEnd) + 8;
  p.head.forEach((h, i) => doc.font(i ? 'r' : 'b').fontSize(8).fillColor('#000').text(h, left, doc.y, { width }));
  doc.moveDown(0.4);

  const cols = [
    { label: 'Item', w: 3.2, num: false },
    { label: 'Qty', w: 1.2, num: true },
    { label: 'MRP', w: 1, num: true },
    { label: 'Disc', w: 0.9, num: true },
    { label: 'GST', w: 0.6, num: true },
    { label: 'Amount', w: 1.1, num: true },
  ];
  const sum = cols.reduce((s, c) => s + c.w, 0);
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
  for (const r of p.rows) row([r.name, r.qty, rupees(r.mrp), r.disc, `${String(r.gstRate)}%`, rupees(r.amount)], false, r.sub);

  doc.moveDown(0.5);
  if (doc.y + 110 > bottom()) doc.addPage();
  const top = doc.y;
  doc.font('b').fontSize(6.8).fillColor('#000').text('HSN · rate · taxable · CGST · SGST', left, top, { width: width / 2 - 8 });
  doc.font('r');
  for (const h of p.hsn) doc.text(`${h.hsn || '—'} · ${String(h.rate)}% · ${rupees(h.taxable)} · ${rupees(h.cgst)} · ${rupees(h.sgst)}`, { width: width / 2 - 8 });
  const hsnEnd = doc.y;
  let ty = top;
  for (const [k, v, bold] of p.totals) {
    doc.font(bold ? 'b' : 'r').fontSize(bold ? 9 : 7.5).fillColor('#000').text(k, left + width / 2, ty, { width: width / 4 });
    doc.text(v, left + (width * 3) / 4, ty, { width: width / 4, align: 'right' });
    ty += bold ? 13 : 10;
  }
  doc.y = Math.max(hsnEnd, ty) + 8;
  if (doc.y + 70 > bottom()) doc.addPage();
  const y = doc.y;
  const textWidth = p.qr ? width - 80 : width;
  doc.font('r').fontSize(7.2).fillColor('#333');
  for (const f of p.foot) doc.text(f, left, doc.y, { width: textWidth });
  if (p.alert) doc.font('b').fillColor('#b42318').text(p.alert, { width: textWidth });

  if (p.qr) {
    const q = qrcode(0, 'M');
    q.addData(p.qr);
    q.make();
    const n = q.getModuleCount();
    const cell = 64 / n;
    const qx = left + width - 64;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) doc.rect(qx + c * cell, y + r * cell, cell + 0.15, cell + 0.15);
    doc.fill('#0f172a');
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('r').fontSize(6.5).fillColor('#777').text(`MedShop · page ${String(i + 1)} of ${String(range.count)}`, left, doc.page.height - 30, { width, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}

const showHsn = async (t: TenantContext) => (await ShopModel.findById(t.shopId).select('settings.tax.showHsnOnBill').lean())?.settings.tax?.showHsnOnBill ?? true;

export async function billPdf(t: TenantContext, userId: string, id: string) {
  const s = await forPdf(t, userId, id);
  const hsnOn = await showHsn(t);
  const totals: Total[] = [['Subtotal (MRP)', rupees(s.subtotal), false]];
  if (s.totalDiscount) totals.push(['Discount', rupees(-s.totalDiscount), false]);
  if (s.aboveMrpAmount) totals.push(['Above MRP', rupees(s.aboveMrpAmount), false]);
  totals.push(['Taxable', rupees(s.taxableAmount), false], ['CGST', rupees(s.cgst), false], ['SGST', rupees(s.sgst), false]);
  if (s.roundOff) totals.push(['Round off', rupees(s.roundOff), false]);
  totals.push(['TOTAL', rupees(s.grandTotal), true]);
  if (s.loyaltyDiscountAmount) totals.push([`Points used (${String(s.loyaltyPointsRedeemed)} pts)`, rupees(-s.loyaltyDiscountAmount), false], ['TO PAY', rupees(s.toPay), true]);
  const points = s.customerId && (s.loyaltyPointsEarned || s.loyaltyPointsRedeemed) ? [`Points: +${String(s.loyaltyPointsEarned)} on this bill${s.loyaltyBalanceAfter !== null ? ` · balance ${String(s.loyaltyBalanceAfter)} pts` : ''}`] : [];
  const cancelled = s.status === 'cancelled';
  const pdf = await paper(t, {
    title: cancelled ? 'CANCELLED' : 'TAX INVOICE',
    danger: cancelled,
    number: s.billNumber,
    at: s.billDate,
    head: [
      `Bill to: ${s.customerName}${s.customerPhone ? ` · ${s.customerPhone}` : ''}`,
      ...(s.doctorName || s.patientName ? [`Doctor: ${s.doctorName || '—'} · Patient: ${s.patientName || '—'}${s.rxNumber ? ` · Rx ${s.rxNumber}` : ''}`] : []),
    ],
    rows: s.lines.map((l) => {
      const rx = l.schedule === 'H1' || l.schedule === 'X' ? ` · Sch ${l.schedule}` : '';
      const hsn = hsnOn && l.hsn ? ` · HSN ${l.hsn}` : '';
      return {
        name: l.productName,
        qty: packLabel(l.quantityInBase, l.salePack, l.unit, l.baseUnit),
        mrp: l.mrp,
        disc: l.discountAmount ? rupees(l.discountAmount) : l.aboveMrpAmount ? `+${rupees(l.aboveMrpAmount)}` : '—',
        gstRate: l.gstRate,
        amount: l.totalAmount,
        sub: `${l.batchNumber} · Exp ${l.expiryDate ? mmyy(l.expiryDate) : 'none'}${rx}${hsn}`,
      };
    }),
    hsn: hsnSummary(s.lines),
    totals,
    foot: [`Paid: ${s.payments.length ? s.payments.map((p) => `${p.mode} ${rupees(p.amount)}`).join(' + ') : '—'}`, ...points, `Billed by ${s.createdByName}. Returns as per the shop’s policy.`],
    alert: cancelled ? `Cancelled by ${s.cancelledBy ?? ''}: ${s.cancelReason ?? ''}` : undefined,
    qr: qrText(s.billNumber, istIsoDay(s.billDate), s.grandTotal),
  });
  return { pdf, name: `Bill-${s.billNumber}` };
}

/** Credit note for a sale return (PLAN §15): the lines that came back, against the original bill. */
export async function returnPdf(t: TenantContext, userId: string, id: string) {
  const r = await returns.forPdf(t, userId, id);
  const hsnOn = await showHsn(t);
  const lines = r.lines.map((l) => ({ ...l, taxableAmount: l.taxable }));
  const totals: Total[] = [['Taxable', rupees(r.taxableAmount), false], ['CGST', rupees(r.cgst), false], ['SGST', rupees(r.sgst), false]];
  if (r.roundOff) totals.push(['Round off', rupees(r.roundOff), false]);
  const money = r.total - r.loyaltyRestoredValue;
  if (r.loyaltyRestoredValue) totals.push(['TOTAL', rupees(r.total), true], [`Points back (${String(r.loyaltyPointsRestored)} pts)`, rupees(-r.loyaltyRestoredValue), false]);
  totals.push(['REFUND', rupees(money), true]);
  const number = r.creditNoteNumber ?? r.returnNumber;
  const pdf = await paper(t, {
    title: 'CREDIT NOTE',
    danger: false,
    number,
    at: r.returnDate,
    head: [`Customer: ${r.customerName}${r.customerPhone ? ` · ${r.customerPhone}` : ''}`, `Against bill ${r.billNumber} of ${dayTime(r.billDate)} · return ${r.returnNumber}`],
    rows: r.lines.map((l) => ({
      name: l.productName,
      qty: packLabel(l.quantity, l.salePack, l.unit, l.baseUnit),
      mrp: l.mrp,
      disc: '—',
      gstRate: l.gstRate,
      amount: l.amount,
      sub: `${l.batchNumber} · Exp ${l.expiryDate ? mmyy(l.expiryDate) : 'none'}${hsnOn && l.hsn ? ` · HSN ${l.hsn}` : ''} · ${l.reason}`,
    })),
    hsn: hsnSummary(lines),
    totals,
    foot: [`Refund: ${r.refundMode === 'CASH' ? 'cash' : r.refundMode === 'ADJUST_CREDIT' ? 'against udhaar' : `credit note ${number}`} ${rupees(money)}`, `Taken back by ${r.createdByName}.`],
  });
  return { pdf, name: `CreditNote-${number}` };
}
