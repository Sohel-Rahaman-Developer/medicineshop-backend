// Barcode bars for the label sheet: EAN-13 / EAN-8 / UPC-A when the code is one (check digit right), else Code 128.
// `bars` is one character per module, "1" black and "0" white, without the quiet zones.

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => p.replace(/[01]/g, (b) => (b === '1' ? '0' : '1')));
const G = R.map((p) => p.split('').reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

// Bar / space widths of Code 128 values 0–105, then the stop.
const C128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 ' +
  '223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 ' +
  '112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 ' +
  '311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 ' +
  '122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'
).split(' ');
const START_B = 104;
const START_C = 105;
const TO_C = 99;
const STOP = 106;

export type BarcodeFormat = 'EAN13' | 'EAN8' | 'CODE128';
export interface Bars {
  format: BarcodeFormat;
  bars: string;
  /** Modules of white each side a scanner needs. */
  quiet: number;
}

/** GS1 check digit of the digits before it. */
export function checkDigit(body: string): number {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10;
}

const valid = (code: string) => checkDigit(code.slice(0, -1)) === Number(code.at(-1));

function ean13(code: string): string {
  const first = Number(code[0]);
  const parity = PARITY[first] ?? '';
  let left = '';
  for (let i = 0; i < 6; i++) left += (parity[i] === 'G' ? G : L)[Number(code[i + 1])] ?? '';
  let right = '';
  for (let i = 7; i < 13; i++) right += R[Number(code[i])] ?? '';
  return `101${left}01010${right}101`;
}

function ean8(code: string): string {
  let left = '';
  for (let i = 0; i < 4; i++) left += L[Number(code[i])] ?? '';
  let right = '';
  for (let i = 4; i < 8; i++) right += R[Number(code[i])] ?? '';
  return `101${left}01010${right}101`;
}

const widths = (value: number) => {
  const w = C128[value] ?? '';
  let out = '';
  for (let i = 0; i < w.length; i++) out += (i % 2 ? '0' : '1').repeat(Number(w[i]));
  return out;
};

/** Code 128: digits in pairs (set C) where they can be — half the width — else set B. */
function code128(code: string): string {
  const values: number[] = [];
  const digits = /^\d+$/.test(code);
  if (digits && code.length % 2 === 0) {
    values.push(START_C);
    for (let i = 0; i < code.length; i += 2) values.push(Number(code.slice(i, i + 2)));
  } else if (digits && code.length >= 5) {
    values.push(START_B, (code.charCodeAt(0) - 32), TO_C);
    for (let i = 1; i < code.length; i += 2) values.push(Number(code.slice(i, i + 2)));
  } else {
    values.push(START_B);
    for (const ch of code) values.push(ch.charCodeAt(0) - 32);
  }
  const check = values.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103;
  return [...values, check, STOP].map(widths).join('');
}

export function barsOf(code: string): Bars {
  if (/^\d{13}$/.test(code) && valid(code)) return { format: 'EAN13', bars: ean13(code), quiet: 11 };
  // UPC-A is EAN-13 with a leading 0, bar for bar.
  if (/^\d{12}$/.test(code) && valid(code)) return { format: 'EAN13', bars: ean13(`0${code}`), quiet: 11 };
  if (/^\d{8}$/.test(code) && valid(code)) return { format: 'EAN8', bars: ean8(code), quiet: 7 };
  return { format: 'CODE128', bars: code128(code), quiet: 10 };
}

/** The shop's own code for a product without one: GS1 "in-store" range 29…, so it never clashes with a maker's barcode. */
export function inStoreCode(seq: number): string {
  const body = `29${String(seq).padStart(10, '0')}`;
  return `${body}${String(checkDigit(body))}`;
}
