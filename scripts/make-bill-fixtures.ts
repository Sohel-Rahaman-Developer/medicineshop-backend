// Writes the supplier bills the shop e2e uploads (frontend/e2e/fixtures): A085013 as Word, A085014 as PDF, and for AI
// reading (D78) a phone photo and a scan — files with no text in them.
/* eslint-disable security/detect-non-literal-fs-filename -- a developer tool: the folder is fixed next to this repo */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeBillPdf } from './lib/bill-pdf';
import { makeDocx } from './lib/docx';
import { MA2_FOOT, MA2_LINES, MA2_TOP, MA_FOOT, MA_HEADER, MA_LINES, MA_TOP } from './lib/ma-bill';

async function main() {
  const dir = path.join(__dirname, '..', '..', 'frontend', 'e2e', 'fixtures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ma-pharma-A085013.docx'), makeDocx([...MA_TOP, MA_FOOT[0] ?? ''], [MA_HEADER, ...MA_LINES]));
  writeFileSync(path.join(dir, 'ma-pharma-A085014.pdf'), await makeBillPdf(MA2_TOP, MA_HEADER, MA2_LINES, MA2_FOOT, { twoLineHeader: true }));
  writeFileSync(path.join(dir, 'ma-pharma-A085013-scan.pdf'), await makeBillPdf(MA_TOP, MA_HEADER, MA_LINES, MA_FOOT, { scan: true }));
  writeFileSync(path.join(dir, 'ma-pharma-A085013-photo.jpg'), await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#f4f1ea' } }).jpeg({ quality: 70 }).toBuffer());
  console.log(`bills written to ${dir}`);
}
void main();
