// D115: a post's body is the editor's JSON. Only these blocks, marks and attributes are kept, so nothing the
// editor did not make (a script, a style, a javascript: link) can reach the public page.

export interface DocMark { type: string; attrs?: Record<string, string | number | null> }
export interface DocNode { type: string; attrs?: Record<string, string | number | boolean | null | number[]>; content?: DocNode[]; text?: string; marks?: DocMark[] }

const BLOCKS = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'horizontalRule', 'image', 'table', 'tableRow', 'tableHeader', 'tableCell', 'text', 'hardBreak']);
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link']);
const MEDIA = /^media:([a-f0-9]{24})$/;
const MAX_DEPTH = 12;
const MAX_TEXT = 200_000;

/** A link the page may carry: the web, mail, phone, or a path on this site. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  if (h.startsWith('/') && !h.startsWith('//')) return h.slice(0, 500);
  if (/^(https?:\/\/|mailto:|tel:)/i.test(h)) {
    try {
      return new URL(h).href.slice(0, 500);
    } catch {
      return null;
    }
  }
  return null;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d);

function cleanMarks(marks: unknown): DocMark[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out: DocMark[] = [];
  for (const m of marks as { type?: unknown; attrs?: { href?: unknown } }[]) {
    if (typeof m.type !== 'string' || !MARKS.has(m.type)) continue;
    if (m.type === 'link') {
      const href = safeHref(m.attrs?.href);
      if (href) out.push({ type: 'link', attrs: { href } });
    } else out.push({ type: m.type });
  }
  return out.length ? out : undefined;
}

function cleanNode(n: unknown, depth: number, budget: { text: number }): DocNode | null {
  if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return null;
  const node = n as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown; text?: unknown; marks?: unknown };
  if (typeof node.type !== 'string' || !BLOCKS.has(node.type)) return null;
  const a = node.attrs ?? {};
  if (node.type === 'text') {
    const text = str(node.text, Math.max(0, budget.text));
    if (!text) return null;
    budget.text -= text.length;
    const marks = cleanMarks(node.marks);
    return marks ? { type: 'text', text, marks } : { type: 'text', text };
  }
  if (node.type === 'image') {
    const src = str(a.src, 300);
    const ok = MEDIA.test(src) || /^https:\/\//.test(src);
    return ok ? { type: 'image', attrs: { src, alt: str(a.alt, 200), title: str(a.title, 200) } } : null;
  }
  const out: DocNode = { type: node.type };
  if (node.type === 'heading') out.attrs = { level: int(a.level, 2, 4, 2) };
  if (node.type === 'orderedList') out.attrs = { start: int(a.start, 1, 10_000, 1) };
  if (node.type === 'codeBlock') out.attrs = { language: str(a.language, 20).replace(/[^a-z0-9+-]/gi, '') || null };
  if (node.type === 'tableCell' || node.type === 'tableHeader') out.attrs = { colspan: int(a.colspan, 1, 20, 1), rowspan: int(a.rowspan, 1, 50, 1) };
  if (Array.isArray(node.content)) {
    const kids = (node.content as unknown[]).map((c) => cleanNode(c, depth + 1, budget)).filter((c): c is DocNode => c !== null);
    if (kids.length) out.content = kids;
  }
  return out;
}

/** The editor's document with only what the blog shows; an empty document when nothing is left. */
export function cleanDoc(doc: unknown): DocNode {
  const budget = { text: MAX_TEXT };
  const raw = doc && typeof doc === 'object' && Array.isArray((doc as { content?: unknown }).content) ? ((doc as { content: unknown[] }).content) : [];
  const content = raw.map((c) => cleanNode(c, 1, budget)).filter((c): c is DocNode => c !== null && c.type !== 'text');
  return { type: 'doc', content };
}

/** Every piece of text, blocks apart by a space. */
export function plainText(n: DocNode): string {
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(plainText).join(n.type === 'paragraph' || n.type === 'heading' ? '' : ' ');
  return n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' || n.type === 'tableCell' || n.type === 'tableHeader' ? `${inner} ` : inner;
}

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The picture ids a document uses (media:<id>). */
export function mediaIds(n: DocNode, out = new Set<string>()): Set<string> {
  const m = n.type === 'image' && typeof n.attrs?.src === 'string' ? MEDIA.exec(n.attrs.src) : null;
  if (m?.[1]) out.add(m[1]);
  for (const c of n.content ?? []) mediaIds(c, out);
  return out;
}

/** Fills each picture's width and height, so the page keeps its place while it loads. */
export function sizeImages(n: DocNode, sizes: Map<string, { width: number; height: number }>): DocNode {
  if (n.type === 'image' && typeof n.attrs?.src === 'string') {
    const id = MEDIA.exec(n.attrs.src)?.[1];
    const s = id ? sizes.get(id) : undefined;
    return s ? { ...n, attrs: { ...n.attrs, width: s.width, height: s.height } } : n;
  }
  return n.content ? { ...n, content: n.content.map((c) => sizeImages(c, sizes)) } : n;
}
