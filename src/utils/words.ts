const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number) {
  return n < 20 ? (ONES[n] ?? '') : `${TENS[Math.floor(n / 10)] ?? ''}${n % 10 ? `-${ONES[n % 10] ?? ''}` : ''}`;
}
function below1000(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h] ?? ''} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

/** Indian grouping: crore, lakh, thousand. */
export function numberInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${numberInWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

/** "Rupees Seven Hundred Ninety-Nine and Fifty Paise Only" — the line Indian invoices carry under the total. */
export function rupeesInWords(paise: number): string {
  const p = Math.abs(Math.round(paise));
  const rs = Math.floor(p / 100);
  const ps = p % 100;
  return `Rupees ${numberInWords(rs)}${ps ? ` and ${below100(ps)} Paise` : ''} Only`;
}
