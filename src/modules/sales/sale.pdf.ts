import { mmyy, dayTime, rupees } from '../../core/export';
import { invoicePdf } from '../../core/invoice-pdf';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { rupeesInWords } from '../../utils/words';
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
  numberLabel: string;
  at: Date;
  extraMeta?: [string, string][];
  parties: { label: string; lines: string[] }[];
  rows: Row[];
  hsn: ReturnType<typeof hsnSummary>;
  totals: Total[];
  words: number;
  foot: string[];
  alert?: string;
  qr?: string;
}

/** A5 tax invoice / credit note on the shared invoice layout (PLAN §14, §15, §35.7). */
async function paper(t: TenantContext, p: Paper) {
  const shop = await ShopModel.findById(t.shopId).select('name address phone gstin drugLicenseNumber').lean();
  const a = shop?.address;
  return invoicePdf({
    size: 'A5',
    title: p.title,
    tone: p.danger ? 'danger' : 'brand',
    meta: [[p.numberLabel, p.number], ['Date', dayTime(p.at)], ...(p.extraMeta ?? [])],
    issuer: {
      name: shop?.name ?? 'MedBox24',
      lines: [[a?.line1, a?.line2, a ? `${a.city} ${a.pincode}` : '', shop?.phone].filter(Boolean).join(', '), [shop?.gstin ? `GSTIN ${shop.gstin}` : '', shop ? `DL ${shop.drugLicenseNumber}` : ''].filter(Boolean).join(' · ')],
    },
    parties: p.parties,
    columns: [{ label: 'Item', w: 3.2 }, { label: 'Qty', w: 1.2, num: true }, { label: 'MRP', w: 1, num: true }, { label: 'Disc', w: 0.9, num: true }, { label: 'GST', w: 0.6, num: true }, { label: 'Amount', w: 1.1, num: true }],
    rows: p.rows.map((r) => ({ cells: [r.name, r.qty, rupees(r.mrp), r.disc, `${String(r.gstRate)}%`, rupees(r.amount)], sub: r.sub })),
    side: p.hsn.length ? { title: 'HSN · rate · taxable · CGST · SGST', lines: p.hsn.map((h) => `${h.hsn || '—'} · ${String(h.rate)}% · ${rupees(h.taxable)} · ${rupees(h.cgst)} · ${rupees(h.sgst)}`) } : undefined,
    totals: p.totals.map(([label, value, strong]) => ({ label, value, strong })),
    words: rupeesInWords(p.words),
    notes: p.foot,
    alert: p.alert,
    qr: p.qr ? { text: p.qr, caption: 'Scan to check this bill' } : undefined,
    footer: 'Computer-generated invoice · MedBox24',
  });
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
    numberLabel: 'Bill no.',
    at: s.billDate,
    parties: [
      { label: 'Bill to', lines: [s.buyerGstin ? (s.buyerName ?? s.customerName) : s.customerName, ...(s.customerPhone ? [s.customerPhone] : []), ...(s.buyerGstin ? [`GSTIN ${s.buyerGstin}`] : [])] },
      ...(s.doctorName || s.patientName ? [{ label: 'Doctor · patient', lines: [s.doctorName || '—', `Patient: ${s.patientName || '—'}${s.rxNumber ? ` · Rx ${s.rxNumber}` : ''}`] }] : []),
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
    words: s.loyaltyDiscountAmount ? s.toPay : s.grandTotal,
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
    numberLabel: 'Credit note',
    at: r.returnDate,
    extraMeta: [['Against bill', r.billNumber]],
    parties: [{ label: 'Customer', lines: [r.customerName, ...(r.customerPhone ? [r.customerPhone] : []), `Return ${r.returnNumber} · bill of ${dayTime(r.billDate)}`] }],
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
    words: money,
    foot: [`Refund: ${r.refundMode === 'CASH' ? 'cash' : r.refundMode === 'ADJUST_CREDIT' ? 'against udhaar' : `credit note ${number}`} ${rupees(money)}`, `Taken back by ${r.createdByName}.`],
  });
  return { pdf, name: `CreditNote-${number}` };
}
