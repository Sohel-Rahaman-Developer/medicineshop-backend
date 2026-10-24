// Writes the two sample supplier bills for showing "Purchase from bill" in the demo shop — to samples/demo-bills, outside the repos.
/* eslint-disable security/detect-non-literal-fs-filename -- a developer tool: the folder is fixed next to this repo */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeInvoicePdf } from './lib/bill-pdf';
import { mehtaBill, sharmaBill } from './lib/demo-bills';

async function main() {
  const dir = path.join(__dirname, '..', '..', 'samples', 'demo-bills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'mehta-medical-MMA-4471.pdf'), await makeInvoicePdf(mehtaBill()));
  writeFileSync(path.join(dir, 'sharma-distributors-SD-1186.pdf'), await makeInvoicePdf(sharmaBill()));
  console.log(`demo bills written to ${dir}`);
}
void main();
