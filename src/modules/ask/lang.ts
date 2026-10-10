// D81: the language a question is asked in, so the answer comes back in it.
export const LANGS = ['en', 'hi', 'bn'] as const;
export type Lang = (typeof LANGS)[number];
/** A language and its script: Hinglish or Banglish typed in Roman letters gets a Roman answer. */
export const VOICES = ['en', 'hi', 'hi_latn', 'bn', 'bn_latn'] as const;
export type Voice = (typeof VOICES)[number];

const BENGALI = /\p{Script=Bengali}/u;
const DEVANAGARI = /\p{Script=Devanagari}/u;
const HI_WORDS = new Set(['kya', 'kitna', 'kitni', 'kitne', 'hai', 'hain', 'ka', 'ke', 'aaj', 'mahine', 'mahina', 'hafte', 'hafta', 'bika', 'bike', 'munafa', 'dena', 'kaun', 'kab', 'sabse', 'zyada', 'jyada', 'bacha', 'bache', 'kam', 'dawai', 'dawa', 'batao', 'dikhao', 'mera', 'meri', 'pichhle', 'pichle', 'hua', 'hui', 'kis', 'kaunsa']);
const BN_WORDS = new Set(['koto', 'ache', 'achhe', 'ase', 'aj', 'ajke', 'ajker', 'gotokal', 'mas', 'mase', 'maser', 'saptaho', 'shoptaho', 'labh', 'baki', 'baaki', 'dite', 'hobe', 'kon', 'kobe', 'sobcheye', 'beshi', 'kom', 'osudh', 'oshudh', 'bolo', 'dekhao', 'amar', 'er', 'theke', 'gulo', 'holo', 'hoyeche', 'korte', 'dokan']);

export function voiceOf(text: string, hint?: Lang): Voice {
  if (BENGALI.test(text)) return 'bn';
  if (DEVANAGARI.test(text)) return 'hi';
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const hi = words.filter((w) => HI_WORDS.has(w)).length;
  const bn = words.filter((w) => BN_WORDS.has(w)).length;
  if (hi > bn) return 'hi_latn';
  if (bn > hi) return 'bn_latn';
  if (hint === 'hi') return 'hi_latn';
  if (hint === 'bn') return 'bn_latn';
  return 'en';
}

export const langOf = (v: Voice): Lang => (v.startsWith('bn') ? 'bn' : v.startsWith('hi') ? 'hi' : 'en');

const digit = (d: string) => {
  const c = d.codePointAt(0) ?? 0;
  return c >= 0x9e6 && c <= 0x9ef ? String(c - 0x9e6) : c >= 0x966 && c <= 0x96f ? String(c - 0x966) : d;
};

/** Lower case, Bengali and Devanagari digits as 0-9, punctuation as spaces; letters and their vowel signs stay. */
export function normalize(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\p{Nd}/gu, (d) => digit(d))
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}
