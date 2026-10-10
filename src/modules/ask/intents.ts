import type { Period } from './facts';
import { normalize } from './lang';

// D81 free layer: a question the software can answer by itself — no AI, no tokens, no coins. Word groups in English,
// Hindi and Bengali (both scripts and Roman); anything it does not recognise goes to the AI, never to a guess.

export type Intent =
  | { kind: 'sales' | 'profit' | 'top'; period: Period }
  | { kind: 'stock'; name: string | null }
  | { kind: 'low' }
  | { kind: 'expiring'; days: number }
  | { kind: 'expired' }
  | { kind: 'udhaar'; name: string | null }
  | { kind: 'suppliers'; name: string | null }
  | { kind: 'salt'; name: string }
  | { kind: 'cash' }
  | { kind: 'help' };

const words = (...w: string[]) => w.map(normalize);

const G = {
  sale: words('sale', 'sales', 'sold', 'sell', 'revenue', 'turnover', 'bill', 'bills', 'bikri', 'bikree', 'bika', 'biki', 'bike', 'bech', 'बिक्री', 'बिका', 'बिकी', 'बिके', 'बेच', 'सेल', 'बिल', 'বিক্রি', 'বিক্রয়', 'বেচা', 'সেল', 'বিল'),
  profit: words('profit', 'margin', 'earning', 'kamai', 'munafa', 'munafe', 'labh', 'मुनाफ', 'लाभ', 'कमाई', 'লাভ', 'মুনাফা'),
  top: words('top', 'best', 'most', 'highest', 'sabse', 'zyada', 'jyada', 'सबसे', 'ज़्यादा', 'ज्यादा', 'সবচেয়ে', 'sobcheye', 'beshi', 'বেশি'),
  stock: words('stock', 'inventory', 'left', 'available', 'bacha', 'bache', 'स्टॉक', 'स्टाक', 'बचा', 'बचे', 'उपलब्ध', 'স্টক', 'মজুত', 'আছে', 'ache', 'achhe'),
  lowStrong: words('reorder', 'order', 'khatam', 'finishing', 'short', 'shortage', 'mangana', 'manga', 'furiye', 'ख़त्म', 'खत्म', 'मंगा', 'ऑर्डर', 'অর্ডার', 'ফুরিয়ে'),
  lowWeak: words('low', 'less', 'kam', 'kom', 'कम', 'কম'),
  expiry: words('expir', 'exp', 'meyad', 'एक्सपायर', 'मियाद', 'মেয়াদ', 'এক্সপায়ার'),
  gone: words('expired', 'gone', 'over', 'khatam', 'shesh', 'beet', 'gaya', 'gayi', 'geche', 'एक्सपायर्ड', 'ख़त्म', 'खत्म', 'बीत', 'गया', 'गई', 'শেষ', 'গেছে'),
  udhaar: words('udhaar', 'udhar', 'udhari', 'credit', 'owe', 'owes', 'baki', 'baaki', 'vasool', 'aday', 'collect', 'उधार', 'बकाया', 'वसूल', 'বাকি', 'বাকী', 'বকেয়া', 'আদায়'),
  supplier: words('supplier', 'distributor', 'wholesaler', 'vendor', 'payable', 'dena', 'सप्लायर', 'डिस्ट्रीब्यूटर', 'देना', 'সাপ্লায়ার', 'ডিস্ট্রিবিউটর', 'দেনা'),
  salt: words('salt', 'substitute', 'alternative', 'alternate', 'generic', 'instead', 'replace', 'same', 'vikalp', 'jaisa', 'bikolpo', 'moto', 'साल्ट', 'विकल्प', 'जैसा', 'জেনেরিক', 'সল্ট', 'বিকল্প', 'মতো'),
  cash: words('cash', 'drawer', 'galla', 'galle', 'nagad', 'nogod', 'गल्ला', 'गल्ले', 'नकद', 'नक़द', 'कैश', 'ক্যাশ', 'নগদ'),
  help: words('help', 'madad', 'sahajjo', 'मदद', 'সাহায্য'),
  // Why, compare, trends, advice and medicine use need thinking — the AI's job, not a card's.
  block: words('why', 'kyon', 'kyun', 'keno', 'compare', 'comparison', 'trend', 'vs', 'versus', 'difference', 'fark', 'predict', 'forecast', 'should', 'suggest', 'advice', 'salah', 'kaise', 'use', 'uses', 'dose', 'dosage', 'side', 'effect', 'kaam', 'kaj', 'khurak', 'increase', 'decrease', 'badh', 'ghat', 'gir', 'क्यों', 'फ़र्क', 'फर्क', 'सलाह', 'कैसे', 'काम', 'खुराक', 'बढ़', 'घट', 'गिर', 'কেন', 'পার্থক্য', 'পরামর্শ', 'কীভাবে', 'কাজ', 'ডোজ', 'বাড়'),
  today: words('today', 'aaj', 'aj', 'ajke', 'ajker', 'आज', 'আজ'),
  yesterday: words('yesterday', 'kal', 'gotokal', 'कल', 'গতকাল'),
  week: words('week', 'hafte', 'hafta', 'saptaho', 'shoptaho', 'saptah', 'हफ़्ते', 'हफ्ते', 'हफ़्ता', 'हफ्ता', 'सप्ताह', 'সপ্তাহ'),
  month: words('month', 'mahine', 'mahina', 'mas', 'mase', 'maser', 'महीने', 'महीना', 'মাস'),
  last: words('last', 'previous', 'pichhle', 'pichle', 'goto', 'पिछले', 'গত'),
  days: words('day', 'days', 'din', 'dine', 'diner', 'दिन', 'দিন'),
  stop: words(
    'what', 'whats', 'how', 'much', 'many', 'is', 'are', 'was', 'were', 'the', 'of', 'for', 'in', 'on', 'do', 'does', 'we', 'i', 'have', 'has', 'had', 'me', 'show', 'tell', 'my', 'our', 'a', 'an', 'with', 'as', 'to', 'there', 'any', 'its', 'it', 's', 'r', 'this', 'that', 'please', 'pls', 'give', 'list', 'all', 'total', 'current', 'now', 'so', 'far', 'till', 'until', 'next', 'coming', 'within', 'which', 'who', 'from', 'by', 'at', 'amount', 'value', 'quantity', 'qty', 'pay', 'paid', 'payment', 'running', 'sellers', 'items', 'item',
    'ka', 'ki', 'ke', 'hai', 'hain', 'tha', 'thi', 'kitna', 'kitni', 'kitne', 'kya', 'mein', 'me', 'se', 'ko', 'aur', 'batao', 'bataiye', 'bata', 'dikhao', 'dikhaiye', 'mera', 'meri', 'mere', 'hamara', 'kaun', 'kaunsa', 'ab', 'abhi', 'tak', 'agle', 'is', 'ye', 'yeh', 'wo', 'woh', 'koi', 'hua', 'hui', 'hue', 'par', 'pe', 'raha', 'rahi', 'kar', 'karna', 'karo', 'chahiye', 'kab', 'sab', 'saare', 'kul',
    'का', 'की', 'के', 'है', 'हैं', 'था', 'थी', 'कितना', 'कितनी', 'कितने', 'क्या', 'में', 'से', 'को', 'और', 'बताओ', 'बताइए', 'दिखाओ', 'मेरा', 'मेरी', 'मेरे', 'हमारा', 'कौन', 'कौनसा', 'अब', 'अभी', 'तक', 'अगले', 'इस', 'यह', 'ये', 'वो', 'कोई', 'हुआ', 'हुई', 'हुए', 'पर', 'रहा', 'रही', 'कर', 'करना', 'चाहिए', 'कब', 'सब', 'कुल',
    'er', 'koto', 'kotota', 'kon', 'konta', 'amar', 'amader', 'dekhao', 'bolo', 'bolun', 'ta', 'ti', 'theke', 'te', 'e', 'ei', 'porer', 'agami', 'holo', 'hoyeche', 'hocche', 'mot', 'gulo', 'kar', 'kader', 'korte', 'hobe', 'dite',
    'এর', 'কত', 'কতটা', 'কী', 'কি', 'আছেন', 'কোন', 'কোনটা', 'আমার', 'আমাদের', 'দেখাও', 'বলো', 'বলুন', 'টা', 'টি', 'থেকে', 'তে', 'এ', 'এই', 'পরের', 'আগামী', 'হলো', 'হয়েছে', 'হচ্ছে', 'মোট', 'সব', 'গুলো', 'কার', 'কাদের', 'করতে', 'হবে', 'দিতে',
  ),
};

const LATIN = /^[a-z0-9]+$/;
// Short Roman words must match whole ("kal" is not "kalpol"); longer ones and Indic words match a word's start (inflections).
const hits = (token: string, term: string) => (LATIN.test(term) && term.length <= 3 ? token === term : token.startsWith(term));

/** Bengali case endings come off a name: রহিমের → রহিম. */
const stem = (w: string) => (/\p{Script=Bengali}/u.test(w) && w.length > 3 ? w.replace(/(দের|ের|এর|কে|র)$/u, '') : w);

export function matchIntent(text: string): Intent | null {
  const tokens = normalize(text).split(' ').filter(Boolean);
  if (!tokens.length || tokens.length > 14) return null;
  const used = new Set<number>();
  const has = (group: string[], whole = false) => {
    let found = false;
    tokens.forEach((t, i) => {
      if (group.some((g) => (whole ? t === g : hits(t, g)))) {
        used.add(i);
        found = true;
      }
    });
    return found;
  };
  // Every group is looked at once, so every word it knows is off the name.
  // Stop words only as whole words, so a name like Rahim keeps its "rahi".
  const on = Object.fromEntries(Object.entries(G).map(([k, g]) => [k, has(g, k === 'stop')])) as Record<keyof typeof G, boolean>;

  let days: number | null = null;
  for (let i = 0; i < tokens.length - 1 && days === null; i++) {
    const t = tokens[i] ?? '';
    const after = tokens[i + 1] ?? '';
    if (/^\d{1,3}$/.test(t) && G.days.some((g) => hits(after, g))) {
      days = Math.min(365, Math.max(1, Number(t)));
      used.add(i);
    }
  }
  const name = tokens.filter((_, i) => !used.has(i)).map(stem).join(' ').trim() || null;
  const latinName = name && /^[a-z0-9 ]+$/.test(name) ? name : null;

  const period = (fallback: Period['key']): Period => {
    if (days !== null) return { key: 'days', n: days };
    if (on.last && on.month) return { key: 'last_month' };
    if (on.last && on.week) return { key: 'days', n: 7 };
    if (on.yesterday) return { key: 'yesterday' };
    if (on.week) return { key: 'week' };
    if (on.month) return { key: 'month' };
    if (on.today) return { key: 'today' };
    return fallback === 'days' ? { key: 'days', n: 7 } : { key: fallback };
  };

  if (on.block) return null;
  if (on.help) return { kind: 'help' };
  if (on.expiry) return days !== null ? { kind: 'expiring', days } : on.gone ? { kind: 'expired' } : { kind: 'expiring', days: 30 };
  if (on.supplier) return { kind: 'suppliers', name };
  if (on.udhaar) return { kind: 'udhaar', name };
  if (on.salt) return latinName ? { kind: 'salt', name: latinName } : null;
  if (on.cash) return { kind: 'cash' };
  if (on.lowStrong || (on.lowWeak && on.stock)) return { kind: 'low' };
  if (on.top && on.sale) return { kind: 'top', period: period('month') };
  if (on.profit) return { kind: 'profit', period: period('month') };
  if (on.sale) return { kind: 'sales', period: period('today') };
  // A product name in another script needs the AI to read it; with no name, the shop's stock as a whole.
  if (on.stock) return name && !latinName ? null : { kind: 'stock', name: latinName };
  return null;
}

/** A bare product name ("Dolo 650") is a stock question, when the shop has it. */
export const bareName = (text: string) => {
  const n = normalize(text);
  return /^[a-z0-9 ]+$/.test(n) && n.split(' ').length <= 3 && /[a-z]{3}/.test(n) ? n : null;
};
