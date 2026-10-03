// Local look at the invoice layout without a database: `npx tsx scripts/preview-invoices.ts <out dir>`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invoicePdf } from '../src/core/invoice-pdf';
import { rupeesInWords } from '../src/utils/words';

const out = process.argv[2] ?? '.';
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

async function main() {
  const items = [
    ['Dolo 650 Tablet', '2 strips', 6_200, '—', '12%', 12_400, 'B24117 · Exp 08/27 · HSN 30049099'],
    ['Pan-D Capsule', '1 strip', 19_900, '₹10.00', '12%', 18_900, 'PD4412 · Exp 01/27 · HSN 30049099'],
    ['Alprax 0.25 Tablet', '10 tabs', 4_800, '—', '12%', 4_800, 'AX2210 · Exp 11/26 · Sch H1 · HSN 30049099'],
    ['Volini Gel 30 g', '1 tube', 14_500, '—', '18%', 14_500, 'VG9921 · Exp 05/28 · HSN 30049011'],
    ['Accu-Chek Active Strips (50)', '1 box', 99_900, '₹50.00', '12%', 94_900, 'Lot AC0921 · no expiry · HSN 38220019'],
    ['Cadbury Dairy Milk 55 g', '2 pcs', 5_000, '—', '18%', 10_000, 'no batch · HSN 18063200'],
  ] as const;
  const bill = await invoicePdf({
    size: 'A5',
    title: 'TAX INVOICE',
    meta: [['Bill no.', 'INV-2026-27-00142'], ['Date', '03 Oct 2026, 11:42 am']],
    issuer: { name: 'Shri Ram Medical Store', lines: ['14B Park Street, Kolkata 700016 · 033 2229 4410', 'GSTIN 19ABCDE1234F1Z5 · DL WB/KOL/RLF20B/2021/0418'] },
    parties: [{ label: 'Bill to', lines: ['Anita Sen', '98300 12345 · Udhaar account'] }, { label: 'Doctor · Patient', lines: ['Dr. R. Ghosh', 'Patient: Anita Sen · Rx 2231'] }],
    columns: [{ label: 'Item', w: 3.2 }, { label: 'Qty', w: 1.2, num: true }, { label: 'MRP', w: 1, num: true }, { label: 'Disc', w: 0.9, num: true }, { label: 'GST', w: 0.6, num: true }, { label: 'Amount', w: 1.1, num: true }],
    rows: items.map((i) => ({ cells: [i[0], i[1], rs(i[2]), i[3], i[4], rs(i[5])], sub: i[6] })),
    side: { title: 'HSN · rate · taxable · CGST · SGST', lines: ['30049099 · 12% · ₹322.32 · ₹19.34 · ₹19.34', '30049011 · 18% · ₹122.88 · ₹11.06 · ₹11.06', '38220019 · 12% · ₹847.32 · ₹50.84 · ₹50.84'] },
    totals: [{ label: 'Subtotal (MRP)', value: '₹1,615.00' }, { label: 'Discount', value: '−₹60.00' }, { label: 'Taxable', value: '₹1,385.40' }, { label: 'CGST', value: '₹84.80' }, { label: 'SGST', value: '₹84.80' }, { label: 'Round off', value: '₹0.00' }, { label: 'TOTAL', value: '₹1,555.00', strong: true }],
    words: rupeesInWords(155_500),
    notes: ['Paid: UPI ₹1,000.00 + Udhaar ₹555.00', 'Points: +15 on this bill · balance 240 pts', 'Billed by Sunita. Returns as per the shop’s policy. Get well soon!'],
    qr: { text: 'MEDSHOP|INV-2026-27-00142|2026-10-03|155500', caption: 'Scan to check this bill' },
    footer: 'Computer-generated invoice · MedShop',
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the developer names the output folder
  writeFileSync(join(out, 'bill.pdf'), bill);
  const inv = await invoicePdf({
    size: 'A4',
    title: 'TAX INVOICE',
    meta: [['Invoice no.', 'MS-2026-27-00002'], ['Date', '03 Oct 2026'], ['Place of supply', 'West Bengal (19)'], ['Reverse charge', 'No']],
    stamp: 'PAID',
    logo: true,
    issuer: { name: 'MedShop Technologies Pvt Ltd', lines: ['5 Camac Street, Kolkata 700017', 'GSTIN 19AABCM1234A1Z5 · support@medshop.in'] },
    parties: [{ label: 'Billed to', lines: ['Shri Ram Medical Store', '14B Park Street, Kolkata, West Bengal 700016', 'GSTIN 19ABCDE1234F1Z5'] }, { label: 'Subscription', lines: ['Monthly plan · up to 5 users', 'Period 03 Oct 2026 – 02 Nov 2026', 'Paid by UPI · pay_RdX81Kq2'] }],
    columns: [{ label: '#', w: 0.4 }, { label: 'Description', w: 4 }, { label: 'SAC', w: 1, num: true }, { label: 'Taxable', w: 1.2, num: true }, { label: 'GST', w: 0.7, num: true }, { label: 'Amount', w: 1.2, num: true }],
    rows: [{ cells: ['1', 'MedShop software subscription — Monthly', '998314', '₹677.12', '18%', '₹799.00'], sub: '30 days · up to 5 users · 03 Oct 2026 – 02 Nov 2026' }],
    totals: [{ label: 'Taxable value', value: '₹677.12' }, { label: 'CGST 9%', value: '₹60.94' }, { label: 'SGST 9%', value: '₹60.94' }, { label: 'Total', value: '₹799.00', strong: true }],
    words: rupeesInWords(79_900),
    notes: ['Thank you for running your shop on MedShop.', 'Questions about this invoice: support@medshop.in'],
    footer: 'Computer-generated invoice — no signature needed · MedShop Technologies Pvt Ltd',
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the developer names the output folder
  writeFileSync(join(out, 'subscription.pdf'), inv);
}

void main();
