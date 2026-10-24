import PDFDocument from 'pdfkit';

export interface BillPdfOptions {
  /** Titles split over two lines where the software does that ("Net" over "Amount"). */
  twoLineHeader?: boolean;
  /** Item rows per page; the header repeats on every page. */
  perPage?: number;
  /** Every letter placed on its own, as some billing software writes PDFs. */
  letters?: boolean;
  password?: string;
  /** No text at all — what a scanned photo saved as PDF looks like to a reader. */
  scan?: boolean;
  /** Titles centred over their columns, as report designers (Crystal Reports) print them. */
  centerTitles?: boolean;
  /** A DOS-style bill: Courier, each line one string padded with spaces. */
  mono?: boolean;
}

const pad = (t: string, w: number, left: boolean) => (left ? t.padEnd(w) : t.padStart(w));

/** The DOS-style layout: fixed-width columns, one text run per line. */
function monoBill(doc: PDFKit.PDFDocument, top: string[], header: string[], rows: string[][], footer: string[]) {
  const cols = header.map((h) => Math.max(h.length, ...rows.map((r) => (r[header.indexOf(h)] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => pad(c, cols[i] ?? 4, LEFT.has(header[i] ?? ''))).join(' ');
  doc.font('Courier').fontSize(6.5);
  const out = [...top, '-'.repeat(line(header).length), line(header), '-'.repeat(line(header).length), ...rows.map(line), '-'.repeat(line(header).length), ...footer];
  out.forEach((t, i) => doc.text(t, 24, 24 + i * 9, { lineBreak: false }));
}

const WIDTH: Record<string, number> = { Qty: 22, Mfr: 48, Pack: 38, 'Product Name': 120, OMRP: 38, MRP: 38, Exp: 28, HSN: 44, Batch: 56, Rate: 38, DIS: 26, SGST: 28, CGST: 28, Amount: 44, 'Net Amount': 48 };
const LEFT = new Set(['Mfr', 'Pack', 'Product Name', 'Batch']);
const TWO: Record<string, [string, string]> = { 'Net Amount': ['Net', 'Amount'], Exp: ['Exp', 'Date'], Batch: ['Batch', 'No.'] };

/** A supplier's bill as a PDF, laid out the way Marg-style billing software prints it. */
export function makeBillPdf(top: string[], header: string[], rows: string[][], footer: string[], o: BillPdfOptions = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24, ...(o.password ? { userPassword: o.password, ownerPassword: `${o.password}!` } : {}) });
  const parts: Buffer[] = [];
  doc.on('data', (b: Buffer) => parts.push(b));
  const done = new Promise<Buffer>((ok) => doc.on('end', () => ok(Buffer.concat(parts))));
  if (o.mono) {
    monoBill(doc, top, header, rows, footer);
    doc.end();
    return done;
  }
  const size = 7.5;
  const put = (t: string, x: number, y: number) => {
    if (o.scan) return;
    if (!o.letters) {
      doc.text(t, x, y, { lineBreak: false });
      return;
    }
    let at = x;
    for (const ch of t) {
      if (ch !== ' ') doc.text(ch, at, y, { lineBreak: false });
      at += doc.widthOfString(ch);
    }
  };
  const cell = (title: string, t: string, x: number, y: number, isTitle = false) => {
    const w = WIDTH[title] ?? 40;
    if (isTitle && o.centerTitles) put(t, x + (w - doc.widthOfString(t)) / 2, y);
    else put(t, LEFT.has(title) ? x : x + w - doc.widthOfString(t), y);
  };
  const xs: number[] = [];
  let x = 24;
  for (const h of header) {
    xs.push(x);
    x += (WIDTH[h] ?? 40) + 7;
  }
  const rule = (y: number) => {
    doc.moveTo(24, y).lineTo(x, y).lineWidth(0.6).stroke();
  };
  const per = o.perPage ?? rows.length;
  const pages = Math.max(1, Math.ceil(rows.length / per));
  for (let p = 0; p < pages; p++) {
    if (p) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12);
    put(top[0] ?? '', 24, 24);
    doc.font('Helvetica').fontSize(8);
    top.slice(1).forEach((t, i) => put(t, 24, 42 + i * 11));
    let y = 50 + top.length * 11;
    rule(y - 4);
    doc.font('Helvetica-Bold').fontSize(size);
    header.forEach((h, i) => {
      const two = o.twoLineHeader ? TWO[h] : undefined;
      cell(h, two ? two[0] : h, xs[i] ?? 0, y, true);
      if (two) cell(h, two[1], xs[i] ?? 0, y + 9, true);
    });
    y += o.twoLineHeader ? 22 : 13;
    rule(y - 3);
    doc.font('Helvetica').fontSize(size);
    for (const r of rows.slice(p * per, (p + 1) * per)) {
      r.forEach((c, i) => {
        if (c) cell(header[i] ?? '', c, xs[i] ?? 0, y);
      });
      y += 12;
    }
    rule(y - 3);
    if (p < pages - 1) {
      put(`Continued on page ${String(p + 2)}`, 24, y + 4);
      continue;
    }
    doc.fontSize(8);
    footer.forEach((t, i) => put(t, 24, y + 6 + i * 11));
  }
  if (o.scan) doc.rect(40, 60, 500, 300).fillOpacity(0.15).fill('#555');
  doc.end();
  return done;
}

export interface InvoicePdf {
  /** The supplier software's colour: the top band, table header and totals. */
  accent: string;
  seller: { name: string; lines: string[] };
  title: string;
  meta: [string, string][];
  buyer: string[];
  header: string[];
  widths: number[];
  /** Titles whose cells are left aligned; the rest are numbers, right aligned. */
  left: string[];
  rows: string[][];
  totals: [string, string][];
  words: string;
  notes: string[];
}

/** A finished-looking supplier invoice (landscape A4) that the bill reader still reads line by line. */
export function makeInvoicePdf(b: InvoicePdf): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, info: { Title: `${b.seller.name} ${b.meta[0]?.[1] ?? ''}`, Producer: b.seller.name } });
  const parts: Buffer[] = [];
  doc.on('data', (c: Buffer) => parts.push(c));
  const done = new Promise<Buffer>((ok) => doc.on('end', () => ok(Buffer.concat(parts))));
  const L = 28;
  const R = doc.page.width - 28;
  const W = R - L;
  const ink = '#1d2433';
  const soft = '#5b6474';
  const line = '#d5dae2';

  doc.rect(0, 0, doc.page.width, 6).fill(b.accent);
  doc.fillColor(b.accent).font('Helvetica-Bold').fontSize(18).text(b.seller.name, L, 24, { lineBreak: false });
  doc.fillColor(soft).font('Helvetica').fontSize(8.5);
  b.seller.lines.forEach((t, i) => doc.text(t, L, 48 + i * 12, { lineBreak: false }));
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text(b.title, R - 200, 24, { width: 200, align: 'right', lineBreak: false });
  b.meta.forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(9).fillColor(soft).text(`${k} :`, R - 200, 46 + i * 13, { width: 90, align: 'right', lineBreak: false });
    doc.font('Helvetica-Bold').fillColor(ink).text(v, R - 104, 46 + i * 13, { width: 104, align: 'right', lineBreak: false });
  });

  const by = 92;
  doc.roundedRect(L, by, W * 0.48, 56, 6).fill('#f4f6f9');
  doc.fillColor(soft).font('Helvetica-Bold').fontSize(7.5).text('BILL TO', L + 10, by + 8, { lineBreak: false });
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text(b.buyer[0] ?? '', L + 10, by + 19, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(soft);
  b.buyer.slice(1).forEach((t, i) => doc.text(t, L + 10, by + 32 + i * 10, { lineBreak: false }));

  const xs: number[] = [];
  let x = L;
  const gap = (W - b.widths.reduce((s, w) => s + w, 0)) / (b.widths.length - 1);
  for (const w of b.widths) {
    xs.push(x);
    x += w + gap;
  }
  const cell = (i: number, t: string, y: number) => {
    const w = b.widths[i] ?? 40;
    const left = b.left.includes(b.header[i] ?? '');
    doc.text(t, left ? (xs[i] ?? 0) : (xs[i] ?? 0) + w - doc.widthOfString(t), y, { lineBreak: false });
  };
  let y = 156;
  doc.rect(L - 4, y - 6, W + 8, 20).fill(b.accent);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5);
  b.header.forEach((h, i) => { cell(i, h, y); });
  y += 20;
  doc.font('Helvetica').fontSize(8);
  b.rows.forEach((r, n) => {
    if (n % 2) doc.rect(L - 4, y - 5, W + 8, 18).fill('#f6f8fb');
    doc.fillColor(ink);
    r.forEach((c, i) => { if (c) cell(i, c, y); });
    y += 18;
  });
  doc.moveTo(L - 4, y - 4).lineTo(R + 4, y - 4).lineWidth(0.8).strokeColor(line).stroke();

  const ty = y + 8;
  const tx = R - 210;
  b.totals.forEach(([k, v], i) => {
    const last = i === b.totals.length - 1;
    const ry = ty + i * 15 + (last ? 6 : 0);
    if (last) doc.roundedRect(tx - 10, ry - 6, R - tx + 14, 22, 5).fill(b.accent);
    doc.fillColor(last ? '#ffffff' : soft).font(last ? 'Helvetica-Bold' : 'Helvetica').fontSize(last ? 10.5 : 8.5).text(k, tx, ry, { lineBreak: false });
    doc.text(v, R - 104, ry, { width: 100, align: 'right', lineBreak: false });
  });
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(8.5).text('Amount in words', L, ty, { lineBreak: false });
  doc.font('Helvetica').fillColor(soft).text(b.words, L, ty + 12, { width: W * 0.55, lineBreak: false });
  b.notes.forEach((t, i) => doc.fontSize(7.5).text(t, L, ty + 34 + i * 11, { lineBreak: false }));
  doc.fillColor(soft).fontSize(7.5).text(`For ${b.seller.name}`, R - 200, ty + 120, { width: 200, align: 'right', lineBreak: false });
  doc.text('Authorised signatory', R - 200, ty + 150, { width: 200, align: 'right', lineBreak: false });
  doc.end();
  return done;
}
