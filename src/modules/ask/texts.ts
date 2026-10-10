import type { Lang, Voice } from './lang';

type Words = Record<Voice, string>;
/** English, Hindi, Bengali; then Roman Hindi and Roman Bengali. */
const w = (en: string, hi: string, bn: string, hiLatn: string, bnLatn: string): Words => ({ en, hi, hi_latn: hiLatn, bn, bn_latn: bnLatn });

export const say = (x: Words, v: Voice, vars: Record<string, string | number> = {}) => x[v].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

export const TEXT = {
  offTopic: w('I can answer only about your shop and medicines.', 'मैं सिर्फ़ आपकी दुकान और दवाइयों के बारे में बता सकता हूँ।', 'আমি শুধু আপনার দোকান আর ওষুধের ব্যাপারে বলতে পারি।', 'Main sirf aapki dukaan aur dawaiyon ke baare mein bata sakta hoon.', 'Ami shudhu apnar dokan ar oshudher byapare bolte pari.'),
  needsAi: w('This one needs AI ({cost}). Ask?', 'इसके लिए AI लगेगा ({cost})। पूछूँ?', 'এর জন্য AI লাগবে ({cost})। জিজ্ঞেস করব?', 'Iske liye AI lagega ({cost}). Poochhun?', 'Er jonno AI lagbe ({cost}). Jiggesh korbo?'),
  coin: w('1 coin', '1 कॉइन', '1 কয়েন', '1 coin', '1 coin'),
  coins: w('{n} coins', '{n} कॉइन', '{n} কয়েন', '{n} coin', '{n} coin'),
  free: w('free — {n} free left', 'मुफ़्त — {n} मुफ़्त बाकी', 'ফ্রি — আর {n}টি ফ্রি', 'free — {n} free baaki', 'free — aro {n}ti free'),
  aiOff: w('AI questions are off right now. The free questions still work.', 'अभी AI सवाल बंद हैं। मुफ़्त सवाल चलते हैं।', 'এখন AI প্রশ্ন বন্ধ আছে। ফ্রি প্রশ্নগুলো চলবে।', 'Abhi AI sawal band hain. Free sawal chalte hain.', 'Ekhon AI proshno bondho. Free proshnogulo cholbe.'),
  shopOff: w('AI answers are off for your shop — the owner can turn them on in Settings → AI coins. Free questions still work.', 'आपकी दुकान में AI जवाब बंद हैं — मालिक Settings → AI coins में चालू कर सकते हैं। मुफ़्त सवाल चलते हैं।', 'আপনার দোকানে AI উত্তর বন্ধ — মালিক Settings → AI coins থেকে চালু করতে পারেন। ফ্রি প্রশ্ন চলবে।', 'Aapki dukaan mein AI jawab band hain — owner Settings → AI coins mein chalu kar sakte hain. Free sawal chalte hain.', 'Apnar dokane AI uttor bondho — malik Settings → AI coins theke chalu korte paren. Free proshno cholbe.'),
  ownerOnly: w('AI questions are for the owner, manager or accountant — ask them.', 'AI सवाल मालिक, मैनेजर या अकाउंटेंट पूछ सकते हैं — उनसे पूछिए।', 'AI প্রশ্ন মালিক, ম্যানেজার বা অ্যাকাউন্ট্যান্ট করতে পারেন — ওঁদের জিজ্ঞেস করুন।', 'AI sawal owner, manager ya accountant poochh sakte hain — unse poochhiye.', 'AI proshno malik, manager ba accountant korte paren — onder jiggesh korun.'),
  dayLimit: w('Your shop has used today’s {n} AI questions. Free questions still work; AI is back tomorrow.', 'आपकी दुकान ने आज के {n} AI सवाल पूरे कर लिए। मुफ़्त सवाल चलते हैं; AI कल फिर।', 'আপনার দোকান আজকের {n}টি AI প্রশ্ন শেষ করেছে। ফ্রি প্রশ্ন চলবে; AI আবার কাল।', 'Aapki dukaan ne aaj ke {n} AI sawal poore kar liye. Free sawal chalte hain; AI kal phir.', 'Apnar dokan ajker {n}ti AI proshno shesh korechhe. Free proshno cholbe; AI abar kal.'),
  budget: w('AI is resting for the rest of this month. Free questions still work.', 'इस महीने AI आराम कर रहा है। मुफ़्त सवाल चलते हैं।', 'এই মাসে AI বিশ্রামে আছে। ফ্রি প্রশ্ন চলবে।', 'Is mahine AI aaram kar raha hai. Free sawal chalte hain.', 'Ei mase AI bishrame achhe. Free proshno cholbe.'),
  noCoins: w('Not enough coins — buy coins in Settings → AI coins.', 'कॉइन कम हैं — Settings → AI coins में खरीदिए।', 'কয়েন কম — Settings → AI coins থেকে কিনুন।', 'Coin kam hain — Settings → AI coins mein kharidiye.', 'Coin kom — Settings → AI coins theke kinun.'),
  failed: w('Could not answer just now — try again. {back}', 'अभी जवाब नहीं मिल सका — फिर कोशिश कीजिए। {back}', 'এখন উত্তর পাওয়া গেল না — আবার চেষ্টা করুন। {back}', 'Abhi jawab nahi mil saka — phir koshish kijiye. {back}', 'Ekhon uttor pawa gelo na — abar chesta korun. {back}'),
  tooBig: w('That needs more steps than allowed — ask something narrower. {back}', 'इसमें ज़्यादा कदम लगेंगे — थोड़ा छोटा सवाल पूछिए। {back}', 'এতে বেশি ধাপ লাগবে — একটু ছোট প্রশ্ন করুন। {back}', 'Ismein zyada kadam lagenge — thoda chhota sawal poochhiye. {back}', 'Ete beshi dhap lagbe — ektu chhoto proshno korun. {back}'),
  back: w('Your coin is back.', 'आपका कॉइन वापस आ गया।', 'আপনার কয়েন ফেরত এসেছে।', 'Aapka coin wapas aa gaya.', 'Apnar coin ferot esechhe.'),
  backFree: w('It was not counted.', 'यह गिना नहीं गया।', 'এটা গোনা হয়নি।', 'Yeh gina nahi gaya.', 'Eta gona hoyni.'),
  noPermission: w('Your role cannot see this.', 'आपके रोल को यह देखने की अनुमति नहीं है।', 'আপনার রোলে এটা দেখার অনুমতি নেই।', 'Aapke role ko yeh dekhne ki ijaazat nahi hai.', 'Apnar role-e eta dekhar onumoti nei.'),
  notFound: w('Nothing named “{name}” in your shop.', 'आपकी दुकान में “{name}” नाम का कुछ नहीं मिला।', 'আপনার দোকানে “{name}” নামে কিছু পাওয়া গেল না।', 'Aapki dukaan mein “{name}” naam ka kuch nahi mila.', 'Apnar dokane “{name}” name kichhu pawa gelo na.'),
  none: w('Nothing here right now.', 'अभी कुछ नहीं।', 'এখন কিছু নেই।', 'Abhi kuch nahi.', 'Ekhon kichhu nei.'),
  noSalt: w('No salt is saved for this product — add it in the product to see substitutes.', 'इस प्रोडक्ट का साल्ट भरा नहीं है — विकल्प देखने के लिए प्रोडक्ट में भरिए।', 'এই প্রোডাক্টের সল্ট দেওয়া নেই — বিকল্প দেখতে প্রোডাক্টে লিখুন।', 'Is product ka salt bhara nahi hai — vikalp dekhne ke liye product mein bhariye.', 'Ei product-er salt deoa nei — bikolpo dekhte product-e likhun.'),
  open: w('Open', 'खोलें', 'খুলুন', 'Kholein', 'Khulun'),
} as const;

export const PERIOD = {
  today: w('Today', 'आज', 'আজ', 'Aaj', 'Aaj'),
  yesterday: w('Yesterday', 'कल', 'গতকাল', 'Kal', 'Gotokal'),
  week: w('This week', 'इस हफ़्ते', 'এই সপ্তাহ', 'Is hafte', 'Ei saptaho'),
  month: w('This month', 'इस महीने', 'এই মাস', 'Is mahine', 'Ei mas'),
  last_month: w('Last month', 'पिछले महीने', 'গত মাস', 'Pichhle mahine', 'Goto mas'),
  days: w('Last {n} days', 'पिछले {n} दिन', 'গত {n} দিন', 'Pichhle {n} din', 'Goto {n} din'),
} as const;

export const TITLE = {
  sales: w('Sales — {period}', 'बिक्री — {period}', 'বিক্রি — {period}', 'Sale — {period}', 'Bikri — {period}'),
  profit: w('Profit — {period}', 'मुनाफ़ा — {period}', 'লাভ — {period}', 'Munafa — {period}', 'Labh — {period}'),
  top: w('Top sellers — {period}', 'सबसे ज़्यादा बिके — {period}', 'সবচেয়ে বেশি বিক্রি — {period}', 'Sabse zyada bike — {period}', 'Sobcheye beshi bikri — {period}'),
  stockOf: w('Stock — {name}', 'स्टॉक — {name}', 'স্টক — {name}', 'Stock — {name}', 'Stock — {name}'),
  stock: w('Stock', 'स्टॉक', 'স্টক', 'Stock', 'Stock'),
  low: w('Running low', 'कम स्टॉक', 'কম স্টক', 'Kam stock', 'Kom stock'),
  expiring: w('Expiring in {n} days', '{n} दिन में एक्सपायरी', '{n} দিনে মেয়াদ শেষ', '{n} din mein expiry', '{n} dine meyad shesh'),
  expired: w('Expired stock', 'एक्सपायर्ड स्टॉक', 'মেয়াদ শেষ স্টক', 'Expired stock', 'Meyad shesh stock'),
  udhaar: w('Udhaar to collect', 'वसूलने वाला उधार', 'আদায়ের বাকি', 'Udhaar vasoolna', 'Baki aday'),
  udhaarOf: w('Udhaar — {name}', 'उधार — {name}', 'বাকি — {name}', 'Udhaar — {name}', 'Baki — {name}'),
  suppliers: w('To pay suppliers', 'सप्लायर को देना', 'সাপ্লায়ারকে দেওয়া', 'Supplier ko dena', 'Supplier ke deoa'),
  supplierOf: w('To pay — {name}', 'देना — {name}', 'দেওয়া — {name}', 'Dena — {name}', 'Deoa — {name}'),
  sameSalt: w('Same salt as {name}, in stock', '{name} जैसा साल्ट, स्टॉक में', '{name}-এর মতো সল্ট, স্টকে আছে', '{name} jaisa salt, stock mein', '{name}-er moto salt, stock-e achhe'),
  cash: w('Cash in the drawer — today', 'गल्ले में नकद — आज', 'ক্যাশে নগদ — আজ', 'Galle mein cash — aaj', 'Cash-e nogod — aaj'),
  help: w('You can ask', 'आप पूछ सकते हैं', 'আপনি জিজ্ঞেস করতে পারেন', 'Aap poochh sakte hain', 'Apni jiggesh korte paren'),
} as const;

export const LABEL = {
  bills: w('Bills', 'बिल', 'বিল', 'Bills', 'Bill'),
  netSale: w('Net sale', 'कुल बिक्री (वापसी घटाकर)', 'নিট বিক্রি (ফেরত বাদে)', 'Net sale', 'Net bikri'),
  gross: w('Billed', 'बिल की रकम', 'বিলের টাকা', 'Billed', 'Bill-er taka'),
  returns: w('Returns', 'वापसी', 'ফেরত', 'Returns', 'Ferot'),
  avgBill: w('Average bill', 'औसत बिल', 'গড় বিল', 'Average bill', 'Gor bill'),
  cancelled: w('Cancelled bills', 'रद्द बिल', 'বাতিল বিল', 'Cancelled bills', 'Batil bill'),
  grossProfit: w('Gross profit', 'सकल मुनाफ़ा', 'মোট লাভ', 'Gross munafa', 'Mot labh'),
  revenue: w('Sales before tax', 'टैक्स से पहले बिक्री', 'ট্যাক্সের আগে বিক্রি', 'Tax se pehle sale', 'Tax-er age bikri'),
  cost: w('Cost of goods', 'माल की लागत', 'মালের খরচ', 'Maal ki laagat', 'Maler khoroch'),
  margin: w('Margin', 'मार्जिन', 'মার্জিন', 'Margin', 'Margin'),
  inStock: w('In stock', 'स्टॉक में', 'স্টকে আছে', 'Stock mein', 'Stock-e'),
  nextExpiry: w('Next expiry', 'अगली एक्सपायरी', 'পরের মেয়াদ', 'Agli expiry', 'Porer meyad'),
  rack: w('Rack', 'रैक', 'র‍্যাক', 'Rack', 'Rack'),
  out: w('Out of stock', 'स्टॉक ख़त्म', 'স্টক শেষ', 'Stock khatam', 'Stock shesh'),
  low: w('Running low', 'कम', 'কম', 'Kam', 'Kom'),
  products: w('Products', 'प्रोडक्ट', 'প্রোডাক্ট', 'Products', 'Product'),
  stockValue: w('Stock value (cost)', 'स्टॉक की कीमत (लागत)', 'স্টকের দাম (খরচ)', 'Stock value (laagat)', 'Stock-er dam (khoroch)'),
  mrpValue: w('Value at MRP', 'MRP पर कीमत', 'MRP-তে দাম', 'MRP par value', 'MRP-te dam'),
  batches: w('Batches', 'बैच', 'ব্যাচ', 'Batches', 'Batch'),
  batch: w('Batch', 'बैच', 'ব্যাচ', 'Batch', 'Batch'),
  customers: w('Customers', 'ग्राहक', 'গ্রাহক', 'Customers', 'Grahok'),
  total: w('Total', 'कुल', 'মোট', 'Total', 'Mot'),
  limit: w('Udhaar limit', 'उधार सीमा', 'বাকির সীমা', 'Udhaar limit', 'Bakir sima'),
  suppliers: w('Suppliers', 'सप्लायर', 'সাপ্লায়ার', 'Suppliers', 'Supplier'),
  overdue: w('Overdue', 'तारीख़ निकल गई', 'তারিখ পেরিয়েছে', 'Overdue', 'Overdue'),
  dueWeek: w('Due this week', 'इस हफ़्ते देना', 'এই সপ্তাহে দিতে হবে', 'Is hafte dena', 'Ei saptahe dite hobe'),
  oldestDue: w('Oldest unpaid bill due', 'सबसे पुराने बिल की तारीख़', 'সবচেয়ে পুরনো বিলের তারিখ', 'Sabse purane bill ki date', 'Sobcheye purono bill-er date'),
  opening: w('Opening cash', 'शुरुआती नकद', 'শুরুর নগদ', 'Opening cash', 'Shurur nogod'),
  cashIn: w('Cash in', 'नकद आया', 'নগদ এল', 'Cash aaya', 'Nogod elo'),
  cashOut: w('Cash out', 'नकद गया', 'নগদ গেল', 'Cash gaya', 'Nogod gelo'),
  expected: w('Should be in the drawer', 'गल्ले में होना चाहिए', 'ক্যাশে থাকা উচিত', 'Galle mein hona chahiye', 'Cash-e thaka uchit'),
} as const;

/** Ready questions for the chat's chips — each one is answered by the free layer (smoke:ask checks every one). */
export const CHIPS: Record<Lang, string[]> = {
  en: ['Today’s sale', 'This month’s profit', 'Top sellers this month', 'Running low on stock', 'Expiring in 30 days', 'Udhaar to collect', 'How much to pay suppliers', 'Cash in the drawer today'],
  hi: ['आज की बिक्री', 'इस महीने का मुनाफ़ा', 'इस महीने सबसे ज़्यादा क्या बिका', 'कम स्टॉक', '30 दिन में एक्सपायरी', 'कुल उधार कितना है', 'सप्लायर को कितना देना है', 'आज गल्ले में कितना नकद'],
  bn: ['আজকের বিক্রি', 'এই মাসের লাভ', 'এই মাসে সবচেয়ে বেশি কী বিক্রি হলো', 'কম স্টক', '30 দিনে মেয়াদ শেষ', 'মোট বাকি কত', 'সাপ্লায়ারকে কত দিতে হবে', 'আজ ক্যাশে কত নগদ'],
};
