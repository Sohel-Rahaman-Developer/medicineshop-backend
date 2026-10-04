// Writes the supplier bills the shop e2e uploads: frontend/e2e/fixtures/ma-pharma-A085013.docx and -A085014.pdf.
/* eslint-disable security/detect-non-literal-fs-filename -- a developer tool: the folder is fixed next to this repo */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeBillPdf } from './lib/bill-pdf';
import { makeDocx } from './lib/docx';
import { MA2_FOOT, MA2_LINES, MA2_TOP, MA_FOOT, MA_HEADER, MA_LINES, MA_TOP } from './lib/ma-bill';

async function main() {
  const dir = path.join(__dirname, '..', '..', 'frontend', 'e2e', 'fixtures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ma-pharma-A085013.docx'), makeDocx([...MA_TOP, MA_FOOT[0] ?? ''], [MA_HEADER, ...MA_LINES]));
  writeFileSync(path.join(dir, 'ma-pharma-A085014.pdf'), await makeBillPdf(MA2_TOP, MA_HEADER, MA2_LINES, MA2_FOOT, { twoLineHeader: true }));
  console.log(`bills written to ${dir}`);
}
void main();
