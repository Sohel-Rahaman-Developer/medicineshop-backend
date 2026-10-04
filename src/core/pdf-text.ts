import path from 'node:path';

/** One run of text on a PDF page: left and right edge, baseline (from the top), font size — in points. */
export interface PdfWord {
  text: string;
  x: number;
  right: number;
  y: number;
  size: number;
}

export class PdfTextError extends Error {
  constructor(readonly reason: 'password' | 'broken' | 'pages') {
    super(reason);
  }
}

const fonts = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').split(path.sep).join('/')}/`;

/** The text of each page with where it sits. Nothing is run from the file — no scripts, no fonts loaded. */
export async function pdfWords(file: Buffer, maxPages = 20): Promise<PdfWord[][]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(file),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    standardFontDataUrl: fonts,
    verbosity: 0,
  });
  try {
    const doc = await task.promise.catch((e: unknown) => {
      throw new PdfTextError(e instanceof Error && e.name === 'PasswordException' ? 'password' : 'broken');
    });
    if (doc.numPages > maxPages) throw new PdfTextError('pages');
    const pages: PdfWord[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const top = page.view[3] ?? 0;
      const content = await page.getTextContent();
      const words: PdfWord[] = [];
      for (const it of content.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        const [a = 0, b = 0, , , x = 0, y = 0] = it.transform as number[];
        // Only upright text; a rotated stamp or watermark is not part of the table.
        if (Math.abs(b) > 0.01 || a <= 0) continue;
        words.push({ text: it.str, x, right: x + it.width, y: top - y, size: Math.abs(it.height) || a });
      }
      pages.push(words);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
