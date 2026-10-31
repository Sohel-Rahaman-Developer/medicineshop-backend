import { DOSE_WORDS, type DoseFreq, type DoseLang, type DoseMeal } from '../../content/dose-words';

export interface Dose {
  freq?: DoseFreq | null;
  /** Morning-afternoon-night, as a prescription writes it: 1-0-1, ½-0-½. */
  pattern?: string | null;
  meal?: DoseMeal | null;
  days?: number | null;
}

export const DOSE_PATTERN = /^(0|½|1|1½|2|3)-(0|½|1|1½|2|3)-(0|½|1|1½|2|3)$/;

/** "How to take: Twice a day · After food · for 5 days" in the bill's language; '' when nothing was chosen. */
export function doseText(d: Dose, lang: DoseLang): string {
  const w = DOSE_WORDS[lang];
  // The Hindi and Bengali fonts have no ½.
  const half = (v: string) => (lang === 'en' ? v : v.replace('½', ' 1/2').trim());
  const parts: string[] = [];
  if (d.freq) parts.push(w.freq[d.freq]);
  if (d.pattern) {
    const slots = d.pattern.split('-').flatMap((v, i) => (v === '0' ? [] : [`${w.slot[i] ?? ''} ${half(v)}`]));
    if (slots.length) parts.push(slots.join(', '));
  }
  if (d.meal) parts.push(w.meal[d.meal]);
  if (d.days) parts.push(w.days(d.days));
  return parts.length ? `${w.lead}: ${parts.join(' · ')}` : '';
}
