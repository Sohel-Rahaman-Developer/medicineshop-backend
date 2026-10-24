// Two supplier bills for showing "Purchase from bill" in the demo shop (demo.data.ts suppliers and products): every
// colour appears — new batches, an MRP change, a product to check, a new product — and the bill adds up.
import { rupeesInWords } from '../../src/utils/words';
import type { InvoicePdf } from './bill-pdf';

type Item = [name: string, company: string, pack: string, batch: string, expiry: string, hsn: string, qty: number, free: number, mrp: number, rate: number, disc: number, gst: number];

const paise = (r: number) => Math.round(r * 100);
const rs = (p: number) => (p / 100).toFixed(2);
const inr = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Line amounts as billing software prints them: Amount = qty × rate, Net = Amount − discount + GST. */
function priced(items: Item[]) {
  return items.map(([name, company, pack, batch, expiry, hsn, qty, free, mrp, rate, disc, gst]) => {
    const amount = qty * paise(rate);
    const off = Math.round((amount * disc) / 100);
    const tax = Math.round(((amount - off) * gst) / 100);
    return { name, company, pack, batch, expiry, hsn, qty, free, mrp: paise(mrp), rate: paise(rate), disc, gst, amount, off, tax, net: amount - off + tax };
  });
}

function totalsOf(lines: ReturnType<typeof priced>) {
  const sum = (k: 'amount' | 'off' | 'tax' | 'net') => lines.reduce((s, l) => s + l[k], 0);
  const net = sum('net');
  const pay = Math.round(net / 100) * 100;
  return {
    pay,
    rows: [
      ['Gross amount', inr(sum('amount'))],
      ['Less discount', `- ${inr(sum('off'))}`],
      ['SGST', inr(Math.floor(sum('tax') / 2))],
      ['CGST', inr(sum('tax') - Math.floor(sum('tax') / 2))],
      ['Round off', `${pay - net < 0 ? '- ' : ''}${inr(Math.abs(pay - net))}`],
    ] as [string, string][],
  };
}

const BUYER = ['MedBox24 Demo Pharmacy', '14B Park Street, Kolkata 700016 · West Bengal', 'DL WB/KOL/RLF20B/2021/0418'];

/** Mehta Medical Agency — Marg-style columns. */
export function mehtaBill(): InvoicePdf {
  const lines = priced([
    ['DOLO 650 TAB', 'MICRO LABS', '15 TAB', 'DL2610', '09/28', '30049099', 30, 3, 33.5, 23.4, 2, 5],
    ['PAN 40 TAB', 'ALKEM', '15 TAB', 'PN6650', '11/28', '30049099', 10, 0, 155.4, 118, 0, 5],
    ['TELMA 40 TAB', 'GLENMARK', '15 TAB', 'TL4490', '10/28', '30049099', 10, 1, 255, 176.6, 2, 5],
    ['ALLEGRA 120 TAB', 'SANOFI', '10 TAB', 'AL1290', '12/28', '30049099', 10, 0, 198, 138, 0, 5],
    ['SHELCAL 500 TAB', 'TORRENT', '15 TAB', 'SH1240', '06/28', '30049099', 12, 0, 120, 84, 3, 5],
    ['GLYCOMET GP 2 TAB', 'USV', '15 TAB', 'GG2210', '08/28', '30049099', 10, 0, 182, 127.4, 0, 5],
    ['NUROKIND GOLD CAP', 'MANKIND', '10 CAP', 'NG1081', '05/28', '30049099', 10, 0, 198.5, 139, 0, 5],
    ['BENADRYL SYRUP 100ML', 'J&J', '100 ML', 'BD9020', '07/28', '30049099', 12, 0, 143, 101, 0, 5],
  ]);
  const t = totalsOf(lines);
  return {
    accent: '#0f5f8c',
    seller: { name: 'Mehta Medical Agency', lines: ['12, Bagri Market, 71 Canning Street, Kolkata 700001', 'Ph 98312 40011 · GSTIN 19AAKFM4521K1Z3 · DL WB/KOL/20B/2207'] },
    title: 'TAX INVOICE',
    meta: [['Invoice No', 'MMA/26-27/4471'], ['Invoice Date', '20-10-2026'], ['Terms', 'Credit 21 days']],
    buyer: BUYER,
    header: ['Qty', 'Free', 'Mfr', 'Pack', 'Product Name', 'MRP', 'Exp', 'HSN', 'Batch', 'Rate', 'Disc %', 'GST %', 'Amount', 'Net Amount'],
    widths: [24, 24, 58, 40, 128, 42, 30, 46, 46, 42, 32, 32, 54, 56],
    left: ['Mfr', 'Pack', 'Product Name', 'Batch'],
    rows: lines.map((l) => [String(l.qty), l.free ? String(l.free) : '', l.company, l.pack, l.name, rs(l.mrp), l.expiry, l.hsn, l.batch, rs(l.rate), l.disc ? l.disc.toFixed(2) : '0.00', l.gst.toFixed(2), rs(l.amount), rs(l.net)]),
    totals: [...t.rows, ['Please Pay', inr(t.pay)]],
    words: rupeesInWords(t.pay),
    notes: ['Bank: HDFC Bank · A/c 50200012345678 · IFSC HDFC0000123', 'Goods once sold will not be taken back. Subject to Kolkata jurisdiction.'],
  };
}

/** Sharma Distributors — Busy-style columns: serial number, item description, PTR. */
export function sharmaBill(): InvoicePdf {
  const lines = priced([
    ['Augmentin 625 Duo Tab', 'GSK', '10 TAB', 'AG7820', '03/28', '30049099', 6, 1, 223.5, 160, 0, 5],
    ['Montair LC Tab', 'CIPLA', '10 TAB', 'ML4570', '10/28', '30049099', 10, 0, 251, 175, 2, 5],
    ['Ascoril LS Syrup 100ml', 'GLENMARK', '100 ML', 'AS1090', '09/28', '30049099', 12, 0, 118, 82, 0, 5],
    ['Digene Gel Mint 200ml', 'ABBOTT', '200 ML', 'DG2090', '08/28', '30049099', 6, 0, 170, 118, 0, 5],
    ['Ensure Vanilla 400g', 'ABBOTT', '400 GM', 'EN4090', '02/28', '21069099', 6, 0, 790, 620, 0, 18],
    ['Accu-Chek Active Strips 50', 'ROCHE', '50 STRIPS', 'AC5090', '11/27', '38220090', 4, 0, 1199, 890, 0, 12],
    ['Cotton Roll 100g', 'JAYCOT', '100 GM', 'CT1090', '12/29', '30059040', 20, 0, 75, 48, 0, 5],
    ['Volini Gel 30g', 'SUN PHARMA', '30 GM', 'VG3011', '04/28', '30049099', 10, 0, 145, 101.5, 0, 5],
  ]);
  const t = totalsOf(lines);
  return {
    accent: '#7a3e9d',
    seller: { name: 'Sharma Distributors', lines: ['P-28, Mangoe Lane, Kolkata 700001', 'Ph 98311 22334 · GSTIN 19ABCDE1234F1Z5 · DL WB/KOL/20B/1189'] },
    title: 'GST INVOICE',
    meta: [['Invoice No', 'SD/2627/1186'], ['Invoice Date', '22-10-2026'], ['Terms', 'Credit 30 days']],
    buyer: BUYER,
    header: ['Sr', 'Item Description', 'Pack', 'Batch No', 'Exp Dt', 'HSN', 'Qty', 'Free', 'MRP', 'PTR', 'Disc%', 'GST%', 'Amount', 'Net Amt'],
    widths: [18, 140, 46, 48, 34, 46, 26, 26, 44, 44, 32, 32, 56, 56],
    left: ['Item Description', 'Pack', 'Batch No'],
    rows: lines.map((l, i) => [String(i + 1), l.name, l.pack, l.batch, l.expiry, l.hsn, String(l.qty), l.free ? String(l.free) : '', rs(l.mrp), rs(l.rate), l.disc ? l.disc.toFixed(2) : '0.00', l.gst.toFixed(2), rs(l.amount), rs(l.net)]),
    totals: [...t.rows, ['Please Pay', inr(t.pay)]],
    words: rupeesInWords(t.pay),
    notes: ['Bank: ICICI Bank · A/c 002105012345 · IFSC ICIC0000021', 'Interest at 18% after the due date. E. & O.E.'],
  };
}
