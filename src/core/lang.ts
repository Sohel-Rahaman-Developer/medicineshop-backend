import type { Request } from 'express';
import hi from '../content/words/hi.json';
import bn from '../content/words/bn.json';
import { logger } from '../config/logger';

// The apps send the person's choice in X-Lang; every message the API shows is English in the code, words/<lang>.json holds the rest.
export type Lang = 'en' | 'hi' | 'bn';
// Maps, not objects: a message like "constructor" must never reach a prototype.
const BOOKS = { hi: new Map<string, string>(Object.entries(hi)), bn: new Map<string, string>(Object.entries(bn)) };

interface Pattern { parts: string[]; names: string[]; to: string }

function compile(book: Map<string, string>): Pattern[] {
  return [...book]
    .filter(([k]) => k.includes('{'))
    .map(([k, to]) => ({ to, parts: k.split(/\{\w+\}/), names: [...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '') }))
    .sort((a, b) => b.parts.join('').length - a.parts.join('').length);
}

/** "Rack {code} added" against "Rack A-1 added" → ["A-1"]; plain indexOf, no regex built from data. */
function fill(parts: string[], text: string): string[] | null {
  const [head = '', ...rest] = parts;
  if (!text.startsWith(head)) return null;
  const vals: string[] = [];
  let at = head.length;
  rest.forEach((p, i) => {
    if (at < 0) return;
    const end = i === rest.length - 1 ? (text.endsWith(p) ? text.length - p.length : -1) : text.indexOf(p, at + 1);
    if (end <= at) at = -1;
    else {
      vals.push(text.slice(at, end));
      at = end + p.length;
    }
  });
  return at < 0 ? null : vals;
}
const PATTERNS = { hi: compile(BOOKS.hi), bn: compile(BOOKS.bn) };

/** Marks an English piece that goes inside a shown message, so check-words lists it; the message translates it in place. */
export const part = (text: string) => text;

export function langOf(req: Request | undefined): Lang {
  const v = req?.get('X-Lang');
  return v === 'hi' || v === 'bn' ? v : 'en';
}

// A filled-in value is translated only when it is a known piece (part()) or a long template, so a name like "Paid Ram" stays as typed.
export function translate(lang: Lang, text: string, depth = 0): string {
  if (lang === 'en' || !text) return text;
  const book = BOOKS[lang];
  const exact = book.get(text);
  if (exact !== undefined) return exact;
  for (const p of PATTERNS[lang]) {
    if (depth && p.parts.join('').length < 8) continue;
    const m = fill(p.parts, text);
    if (!m) continue;
    const vals = new Map(p.names.map((n, i) => [n, m[i] ?? '']));
    return p.to.replace(/\{(\w+)\}/g, (all, n: string) => {
      const v = vals.get(n);
      return v === undefined ? all : depth < 2 ? translate(lang, v, depth + 1) : v;
    });
  }
  if (!depth) logger.warn({ lang, text }, 'Message has no words');
  return text;
}

export const say = (req: Request | undefined, text: string) => translate(langOf(req), text);

const NOTES = new Set(['errors', 'warnings', 'notes']);

/** Row errors, warnings and bill notes inside a preview, in the person's language; everything else is left as it is. */
export function sayNotes<T>(lang: Lang, data: T): T {
  if (lang === 'en') return data;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    // Plain objects only: an ObjectId or a Date goes out exactly as it came.
    if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, NOTES.has(k) && Array.isArray(x) && x.every((s) => typeof s === 'string') ? x.map((s: string) => translate(lang, s)) : walk(x)]));
  };
  return walk(data) as T;
}
