import PDFDocument from 'pdfkit';
import qrcode from 'qrcode-generator';
import { BOLD, FONT } from './export';
import { brandFile } from '../modules/branding/branding.service';

/** One designed layout for every invoice-like paper: the shop's bill and credit note, MedBox24's own invoice. */
export interface InvoiceSpec {
  size: 'A4' | 'A5';
  title: string;
  tone?: 'brand' | 'danger';
  /** Number, date and anything else for the top-right block. */
  meta: [string, string][];
  stamp?: string;
  issuer: { name: string; lines: string[] };
  /** MedBox24's own papers carry the app mark beside the issuer. */
  logo?: boolean;
  parties: { label: string; lines: string[] }[];
  columns: { label: string; w: number; num?: boolean }[];
  rows: { cells: string[]; sub?: string }[];
  side?: { title: string; lines: string[] };
  totals: { label: string; value: string; strong?: boolean }[];
  words?: string;
  notes: string[];
  alert?: string;
  qr?: { text: string; caption: string };
  footer: string;
}

const C = { ink: '#0f172a', muted: '#64748b', brand: '#0fb5a8', dark: '#0b3b43', soft: '#e8f7f5', line: '#dbe4e8', zebra: '#f6f9fa', danger: '#b42318', dangerSoft: '#fdecea', ok: '#067647', okSoft: '#e7f6ec' };

/** The MedBox24 box-and-plus (frontend public/brand/mark-compact.svg), drawn in the PDF so it stays sharp. */
function mark(doc: PDFKit.PDFDocument, x: number, y: number, size: number) {
  const plus = 'M306 110h40v40h40v40h-40v40h-40v-40h-40v-40h40z';
  doc.save().translate(x, y).scale(size / 512).translate(256, 256).scale(1.5).translate(-249, -262);
  const box = doc.linearGradient(113, 0, 349, 0);
  box.stop(0, '#2a6cf5').stop(1, '#12b7a7');
  doc.roundedRect(113, 124, 236, 290, 50).fill(box);
  doc.path(plus).lineWidth(28).lineJoin('round').fillAndStroke('#ffffff', '#ffffff');
  const cross = doc.linearGradient(266, 0, 386, 0);
  cross.stop(0, '#2a6cf5').stop(1, '#12b7a7');
  doc.path(plus).fill(cross);
  doc.restore();
  doc.fillOpacity(1).lineWidth(1).lineJoin('miter');
}

export async function invoicePdf(s: InvoiceSpec): Promise<Buffer> {
  const big = s.size === 'A4';
  const k = big ? 1.22 : 1;
  const M = big ? 36 : 22;
  const doc = new PDFDocument({ size: s.size, margin: M, bufferPages: true, info: { Title: `${s.title} ${s.meta[0]?.[1] ?? ''}`, Producer: 'MedBox24' } });
  doc.registerFont('r', FONT);
  doc.registerFont('b', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => { resolve(Buffer.concat(chunks)); }));
  const W = doc.page.width - 2 * M;
  const bottom = () => doc.page.height - M - 18 * k;
  const accent = s.tone === 'danger' ? C.danger : C.brand;
  const bar = () => doc.rect(0, 0, doc.page.width, 5 * k).fill(accent);

  // Header: issuer on the left, title and its numbers on the right.
  bar();
  let y = M + 2;
  const tile = s.logo ? 30 * k : 0;
  if (s.logo) {
    // A logo uploaded in the admin console replaces the drawn MedBox24 mark.
    const custom = await brandFile('mark.png');
    if (custom) doc.image(custom, M, y, { width: tile, height: tile });
    else mark(doc, M, y, tile);
  }
  const ix = M + (tile ? tile + 8 : 0);
  const lw = W * 0.58 - (ix - M);
  let nameSize = 13.5 * k;
  doc.font('b');
  while (nameSize > 10.5 * k && doc.fontSize(nameSize).widthOfString(s.issuer.name) > lw) nameSize -= 0.5;
  doc.fontSize(nameSize).fillColor(C.dark).text(s.issuer.name, ix, y, { width: lw });
  doc.font('r').fontSize(7 * k).fillColor(C.muted);
  for (const l of s.issuer.lines) doc.text(l, ix, doc.y + 1, { width: lw });
  const leftEnd = Math.max(doc.y, y + tile);
  const rx = M + W * 0.6;
  const rw = W * 0.4;
  doc.font('b').fontSize(14 * k).fillColor(s.tone === 'danger' ? C.danger : C.dark).text(s.title, rx, y, { width: rw, align: 'right' });
  let my = doc.y + 3;
  doc.font('r').fontSize(7 * k);
  const labelW = Math.min(rw * 0.5, Math.max(...s.meta.map(([l]) => doc.widthOfString(l))) + 2);
  for (const [label, value] of s.meta) {
    doc.font('r').fontSize(7 * k).fillColor(C.muted).text(label, rx, my, { width: labelW, align: 'right' });
    const lh = doc.y;
    doc.font('b').fontSize(7.4 * k).fillColor(C.ink).text(value, rx + labelW + 6, my, { width: rw - labelW - 6, align: 'right' });
    my = Math.max(doc.y, lh, my + 9.5 * k);
  }
  if (s.stamp) {
    doc.font('b').fontSize(7.5 * k);
    const sw = doc.widthOfString(s.stamp) + 14 * k;
    doc.roundedRect(rx + rw - sw, my + 2, sw, 13 * k, 6.5 * k).fill(C.okSoft);
    doc.fillColor(C.ok).text(s.stamp, rx + rw - sw, my + 2 + 3 * k, { width: sw, align: 'center' });
    my += 17 * k;
  }
  y = Math.max(leftEnd, my) + 7 * k;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).stroke(C.line);
  y += 8 * k;

  // Who: one or two soft boxes.
  if (s.parties.length) {
    const gap = 8 * k;
    const bw = (W - gap * (s.parties.length - 1)) / s.parties.length;
    const pad = 7 * k;
    doc.fontSize(7.4 * k);
    const heights = s.parties.map((p) => 10 * k + p.lines.reduce((h, l, i) => h + doc.font(i ? 'r' : 'b').heightOfString(l, { width: bw - 2 * pad }) + 1, 0));
    const bh = Math.max(...heights) + 2 * pad;
    s.parties.forEach((p, i) => {
      const bx = M + i * (bw + gap);
      doc.roundedRect(bx, y, bw, bh, 6 * k).fill(C.soft);
      doc.font('b').fontSize(6.3 * k).fillColor(C.brand).text(p.label.toUpperCase(), bx + pad, y + pad, { width: bw - 2 * pad, characterSpacing: 0.6 });
      let ly = doc.y + 2;
      p.lines.forEach((l, j) => {
        doc.font(j ? 'r' : 'b').fontSize((j ? 7.2 : 8) * k).fillColor(j ? C.muted : C.ink).text(l, bx + pad, ly, { width: bw - 2 * pad });
        ly = doc.y + 1;
      });
    });
    y += bh + 10 * k;
  }

  // Lines: a dark header, zebra rows, the batch / HSN line under each item.
  const sum = s.columns.reduce((a, c) => a + c.w, 0);
  const widths = s.columns.map((c) => (W * c.w) / sum);
  const fs = 7.4 * k;
  const head = () => {
    const h = 15 * k;
    doc.roundedRect(M, y, W, h, 4 * k).fill(C.dark);
    let x = M;
    s.columns.forEach((c, i) => {
      doc.font('b').fontSize(6.8 * k).fillColor('#ffffff').text(c.label, x + 4, y + 4.2 * k, { width: (widths[i] ?? 30) - 8, align: c.num ? 'right' : 'left', lineBreak: false });
      x += widths[i] ?? 30;
    });
    y += h;
  };
  head();
  s.rows.forEach((r, n) => {
    doc.font('r').fontSize(fs);
    const subH = r.sub ? doc.fontSize(6.3 * k).heightOfString(r.sub, { width: (widths[0] ?? 100) + (widths[1] ?? 0) - 8 }) + 1 : 0;
    doc.fontSize(fs);
    const h = Math.max(...r.cells.map((c, i) => doc.font(i === 0 ? 'b' : 'r').heightOfString(c, { width: (widths[i] ?? 30) - 8 }))) + subH + 8 * k;
    if (y + h > bottom()) {
      doc.addPage();
      bar();
      y = M;
      head();
    }
    if (n % 2) doc.rect(M, y, W, h).fill(C.zebra);
    let x = M;
    r.cells.forEach((c, i) => {
      doc.font(i === 0 ? 'b' : 'r').fontSize(fs).fillColor(C.ink).text(c, x + 4, y + 4 * k, { width: (widths[i] ?? 30) - 8, align: s.columns[i]?.num ? 'right' : 'left' });
      x += widths[i] ?? 30;
    });
    if (r.sub) doc.font('r').fontSize(6.3 * k).fillColor(C.muted).text(r.sub, M + 4, y + h - subH - 3 * k, { width: (widths[0] ?? 100) + (widths[1] ?? 0) - 8 });
    y += h;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.4).stroke(C.line);
  });
  y += 10 * k;

  // Totals on the right; tax summary and the amount in words on the left.
  const tw = W * 0.44;
  const tx = M + W - tw;
  const sw = W - tw - 12 * k;
  const rowH = (t: { strong?: boolean }) => (t.strong ? 17 : 12) * k;
  const totalsH = s.totals.reduce((h, t) => h + rowH(t), 0) + 8 * k;
  doc.fontSize(6.8 * k);
  const sideH = (s.side ? 12 * k + s.side.lines.reduce((h, l) => h + doc.heightOfString(l, { width: sw }) + 1, 0) : 0) + (s.words ? 28 * k : 0);
  if (y + Math.max(totalsH, sideH) > bottom()) {
    doc.addPage();
    bar();
    y = M;
  }
  doc.roundedRect(tx, y, tw, totalsH, 6 * k).lineWidth(0.7).stroke(C.line);
  let ty = y + 4 * k;
  for (const t of s.totals) {
    const h = rowH(t);
    if (t.strong) doc.roundedRect(tx + 3, ty, tw - 6, h - 2, 4 * k).fill(accent);
    const color = t.strong ? '#ffffff' : C.ink;
    doc.font(t.strong ? 'b' : 'r').fontSize((t.strong ? 9 : 7.4) * k).fillColor(t.strong ? '#ffffff' : C.muted).text(t.label, tx + 9, ty + (t.strong ? 4 : 2) * k, { width: tw * 0.5 });
    doc.font('b').fontSize((t.strong ? 9.5 : 7.4) * k).fillColor(color).text(t.value, tx + tw * 0.45, ty + (t.strong ? 4 : 2) * k, { width: tw * 0.55 - 9, align: 'right' });
    ty += h;
  }
  let sy = y;
  if (s.side) {
    doc.font('b').fontSize(6.6 * k).fillColor(C.dark).text(s.side.title, M, sy, { width: sw });
    doc.font('r').fontSize(6.8 * k).fillColor(C.muted);
    for (const l of s.side.lines) doc.text(l, M, doc.y + 1, { width: sw });
    sy = doc.y + 6 * k;
  }
  if (s.words) {
    doc.font('b').fontSize(6.3 * k).fillColor(C.brand).text('AMOUNT IN WORDS', M, sy, { width: sw, characterSpacing: 0.6 });
    doc.font('b').fontSize(7.4 * k).fillColor(C.ink).text(s.words, M, doc.y + 1, { width: sw });
    sy = doc.y;
  }
  y = Math.max(y + totalsH, sy) + 12 * k;

  // Notes, an alert, and the QR to check the paper.
  const qs = s.qr ? 58 * k : 0;
  if (y + Math.max(qs + 12 * k, 30 * k) > bottom()) {
    doc.addPage();
    bar();
    y = M;
  }
  const nw = W - (qs ? qs + 14 * k : 0);
  doc.font('r').fontSize(7.2 * k).fillColor(C.ink);
  let ny = y;
  for (const n of s.notes) {
    doc.text(n, M, ny, { width: nw });
    ny = doc.y + 2;
  }
  if (s.alert) {
    doc.font('b').fontSize(7.4 * k);
    const ah = doc.heightOfString(s.alert, { width: nw - 12 }) + 10;
    doc.roundedRect(M, ny + 2, nw, ah, 5 * k).fill(C.dangerSoft);
    doc.fillColor(C.danger).text(s.alert, M + 6, ny + 7, { width: nw - 12 });
  }
  if (s.qr) {
    const q = qrcode(0, 'M');
    q.addData(s.qr.text);
    q.make();
    const count = q.getModuleCount();
    const cell = qs / count;
    const qx = M + W - qs;
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) doc.rect(qx + c * cell, y + r * cell, cell + 0.15, cell + 0.15);
    doc.fill(C.ink);
    doc.font('r').fontSize(6 * k).fillColor(C.muted).text(s.qr.caption, qx - 20, y + qs + 3, { width: qs + 20, align: 'right' });
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits inside the bottom margin; without this pdfkit starts a new page for it.
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - M - 6 * k;
    doc.moveTo(M, fy - 4).lineTo(M + W, fy - 4).lineWidth(0.4).stroke(C.line);
    doc.font('r').fontSize(6.3 * k).fillColor(C.muted).text(s.footer, M, fy, { width: W * 0.75, lineBreak: false });
    doc.text(`Page ${String(i + 1)} of ${String(range.count)}`, M + W * 0.75, fy, { width: W * 0.25, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
