// D106: "How to take" on the bill, in the language the customer reads. Same words as the shop app's content/dose-words.ts.
export const DOSE_FREQS = ['OD', 'BD', 'TDS', 'QDS', 'HS', 'SOS', 'STAT'] as const;
export const DOSE_MEALS = ['AC', 'PC'] as const;
export const DOSE_LANGS = ['en', 'hi', 'bn'] as const;
export type DoseFreq = (typeof DOSE_FREQS)[number];
export type DoseMeal = (typeof DOSE_MEALS)[number];
export type DoseLang = (typeof DOSE_LANGS)[number];

interface Words {
  lead: string;
  freq: Record<DoseFreq, string>;
  meal: Record<DoseMeal, string>;
  slot: [string, string, string];
  days: (n: number) => string;
}

export const DOSE_WORDS: Record<DoseLang, Words> = {
  en: {
    lead: 'How to take',
    freq: { OD: 'Once a day', BD: 'Twice a day', TDS: '3 times a day', QDS: '4 times a day', HS: 'Once at bedtime', SOS: 'Only when needed', STAT: 'At once, right now' },
    meal: { AC: 'Before food', PC: 'After food' },
    slot: ['Morning', 'Afternoon', 'Night'],
    days: (n) => (n === 1 ? 'for 1 day' : `for ${String(n)} days`),
  },
  hi: {
    lead: 'कैसे लें',
    freq: { OD: 'दिन में एक बार', BD: 'दिन में दो बार', TDS: 'दिन में तीन बार', QDS: 'दिन में चार बार', HS: 'रात को सोते समय एक बार', SOS: 'ज़रूरत होने पर ही', STAT: 'अभी तुरंत' },
    meal: { AC: 'खाने से पहले', PC: 'खाने के बाद' },
    slot: ['सुबह', 'दोपहर', 'रात'],
    days: (n) => `${String(n)} दिन तक`,
  },
  bn: {
    lead: 'কীভাবে নেবেন',
    freq: { OD: 'দিনে একবার', BD: 'দিনে দুবার', TDS: 'দিনে তিনবার', QDS: 'দিনে চারবার', HS: 'রাতে শোয়ার আগে একবার', SOS: 'প্রয়োজন হলে', STAT: 'এখনই' },
    meal: { AC: 'খাবার আগে', PC: 'খাবার পরে' },
    slot: ['সকাল', 'দুপুর', 'রাত'],
    days: (n) => `${String(n)} দিন`,
  },
};
