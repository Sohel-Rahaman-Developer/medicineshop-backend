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
