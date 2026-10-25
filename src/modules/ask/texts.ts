import type { Lang, Voice } from './lang';

type Words = Record<Voice, string>;
/** English, Hindi, Bengali; then Roman Hindi and Roman Bengali. */
const w = (en: string, hi: string, bn: string, hiLatn: string, bnLatn: string): Words => ({ en, hi, hi_latn: hiLatn, bn, bn_latn: bnLatn });

export const say = (x: Words, v: Voice, vars: Record<string, string | number> = {}) => x[v].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

export const TEXT = {
  offTopic: w('I can talk about your shop, your business and medicines — no token was taken.', 'मैं आपकी दुकान, आपके कारोबार और दवाइयों के बारे में बात कर सकता हूँ — टोकन नहीं कटा।', 'আমি আপনার দোকান, ব্যবসা আর ওষুধের ব্যাপারে কথা বলতে পারি — টোকেন কাটা হয়নি।', 'Main aapki dukaan, kaarobaar aur dawaiyon ke baare mein baat kar sakta hoon — token nahi kata.', 'Ami apnar dokan, byabsa ar oshudher byapare kotha bolte pari — token kata hoyni.'),
  aiOff: w('AI answers are off right now. The ready answers (the buttons) still work.', 'अभी AI जवाब बंद हैं। तैयार जवाब (बटन वाले) चलते हैं।', 'এখন AI উত্তর বন্ধ আছে। তৈরি উত্তরগুলো (বোতামের) চলবে।', 'Abhi AI jawab band hain. Taiyar jawab (button wale) chalte hain.', 'Ekhon AI uttor bondho. Toiri uttor (button-er) cholbe.'),
  plan: w('AI answers are in the Pro plan — upgrade in Settings → Plan. The ready answers (the buttons) still work.', 'AI जवाब Pro प्लान में हैं — Settings → Plan में अपग्रेड कीजिए। तैयार जवाब (बटन वाले) चलते हैं।', 'AI উত্তর Pro প্ল্যানে আছে — Settings → Plan থেকে আপগ্রেড করুন। তৈরি উত্তরগুলো (বোতামের) চলবে।', 'AI jawab Pro plan mein hain — Settings → Plan mein upgrade kijiye. Taiyar jawab (button wale) chalte hain.', 'AI uttor Pro plan-e achhe — Settings → Plan theke upgrade korun. Toiri uttor (button-er) cholbe.'),
  shopOff: w('AI answers are off for your shop — the owner can turn them on in Settings → AI tokens. The ready answers (the buttons) still work.', 'आपकी दुकान में AI जवाब बंद हैं — मालिक Settings → AI tokens में चालू कर सकते हैं। तैयार जवाब (बटन वाले) चलते हैं।', 'আপনার দোকানে AI উত্তর বন্ধ — মালিক Settings → AI tokens থেকে চালু করতে পারেন। তৈরি উত্তরগুলো (বোতামের) চলবে।', 'Aapki dukaan mein AI jawab band hain — owner Settings → AI tokens mein chalu kar sakte hain. Taiyar jawab (button wale) chalte hain.', 'Apnar dokane AI uttor bondho — malik Settings → AI tokens theke chalu korte paren. Toiri uttor (button-er) cholbe.'),
  ownerOnly: w('AI answers are for the owner, manager or accountant — ask them.', 'AI जवाब मालिक, मैनेजर या अकाउंटेंट के लिए हैं — उनसे पूछिए।', 'AI উত্তর মালিক, ম্যানেজার বা অ্যাকাউন্ট্যান্টের জন্য — ওঁদের জিজ্ঞেস করুন।', 'AI jawab owner, manager ya accountant ke liye hain — unse poochhiye.', 'AI uttor malik, manager ba accountant-er jonno — onder jiggesh korun.'),
  dayLimit: w('Your shop has used today’s {n} AI answers; AI is back tomorrow. The ready answers (the buttons) still work.', 'आपकी दुकान ने आज के {n} AI जवाब पूरे कर लिए; AI कल फिर। तैयार जवाब (बटन वाले) चलते हैं।', 'আপনার দোকান আজকের {n}টি AI উত্তর শেষ করেছে; AI আবার কাল। তৈরি উত্তরগুলো (বোতামের) চলবে।', 'Aapki dukaan ne aaj ke {n} AI jawab poore kar liye; AI kal phir. Taiyar jawab (button wale) chalte hain.', 'Apnar dokan ajker {n}ti AI uttor shesh korechhe; AI abar kal. Toiri uttor (button-er) cholbe.'),
  paused: w('AI answers are paused for your shop — MedBox24 has been told and will sort it out. The ready answers (the buttons) still work.', 'आपकी दुकान के लिए AI जवाब अभी रुके हैं — MedBox24 को बता दिया गया है। तैयार जवाब (बटन वाले) चलते हैं।', 'আপনার দোকানের জন্য AI উত্তর এখন বন্ধ — MedBox24-কে জানানো হয়েছে। তৈরি উত্তরগুলো (বোতামের) চলবে।', 'Aapki dukaan ke liye AI jawab abhi ruke hain — MedBox24 ko bata diya gaya hai. Taiyar jawab (button wale) chalte hain.', 'Apnar dokaner jonno AI uttor ekhon bondho — MedBox24-ke janano hoyechhe. Toiri uttor (button-er) cholbe.'),
  budget: w('AI is resting for the rest of this month. The ready answers (the buttons) still work.', 'इस महीने AI आराम कर रहा है। तैयार जवाब (बटन वाले) चलते हैं।', 'এই মাসে AI বিশ্রামে আছে। তৈরি উত্তরগুলো (বোতামের) চলবে।', 'Is mahine AI aaram kar raha hai. Taiyar jawab (button wale) chalte hain.', 'Ei mase AI bishrame achhe. Toiri uttor (button-er) cholbe.'),
  noCoins: w('No AI tokens left — buy more in Settings → AI tokens. The ready answers (the buttons) still work.', 'AI टोकन खत्म — Settings → AI tokens में और खरीदिए। तैयार जवाब (बटन वाले) चलते हैं।', 'AI টোকেন শেষ — Settings → AI tokens থেকে আরও কিনুন। তৈরি উত্তরগুলো (বোতামের) চলবে।', 'AI token khatam — Settings → AI tokens mein aur kharidiye. Taiyar jawab (button wale) chalte hain.', 'AI token shesh — Settings → AI tokens theke aro kinun. Toiri uttor (button-er) cholbe.'),
  failed: w('Could not answer just now — try again. {back}', 'अभी जवाब नहीं मिल सका — फिर कोशिश कीजिए। {back}', 'এখন উত্তর পাওয়া গেল না — আবার চেষ্টা করুন। {back}', 'Abhi jawab nahi mil saka — phir koshish kijiye. {back}', 'Ekhon uttor pawa gelo na — abar chesta korun. {back}'),
  tooBig: w('That needs more steps than allowed — ask something narrower. {back}', 'इसमें ज़्यादा कदम लगेंगे — थोड़ा छोटा सवाल पूछिए। {back}', 'এতে বেশি ধাপ লাগবে — একটু ছোট প্রশ্ন করুন। {back}', 'Ismein zyada kadam lagenge — thoda chhota sawal poochhiye. {back}', 'Ete beshi dhap lagbe — ektu chhoto proshno korun. {back}'),
  back: w('Your token is back.', 'आपका टोकन वापस आ गया।', 'আপনার টোকেন ফেরত এসেছে।', 'Aapka token wapas aa gaya.', 'Apnar token ferot esechhe.'),
  noPermission: w('Your role cannot see this.', 'आपके रोल को यह देखने की अनुमति नहीं है।', 'আপনার রোলে এটা দেখার অনুমতি নেই।', 'Aapke role ko yeh dekhne ki ijaazat nahi hai.', 'Apnar role-e eta dekhar onumoti nei.'),
  notFound: w('Nothing named “{name}” in your shop.', 'आपकी दुकान में “{name}” नाम का कुछ नहीं मिला।', 'আপনার দোকানে “{name}” নামে কিছু পাওয়া গেল না।', 'Aapki dukaan mein “{name}” naam ka kuch nahi mila.', 'Apnar dokane “{name}” name kichhu pawa gelo na.'),
  none: w('Nothing here right now.', 'अभी कुछ नहीं।', 'এখন কিছু নেই।', 'Abhi kuch nahi.', 'Ekhon kichhu nei.'),
  noSalt: w('No salt is saved for this product — add it in the product to see substitutes.', 'इस प्रोडक्ट का साल्ट भरा नहीं है — विकल्प देखने के लिए प्रोडक्ट में भरिए।', 'এই প্রোডাক্টের সল্ট দেওয়া নেই — বিকল্প দেখতে প্রোডাক্টে লিখুন।', 'Is product ka salt bhara nahi hai — vikalp dekhne ke liye product mein bhariye.', 'Ei product-er salt deoa nei — bikolpo dekhte product-e likhun.'),
  open: w('Open', 'खोलें', 'খুলুন', 'Kholein', 'Khulun'),
  compareNote: w('Same stretch of time: {now} against {before}. Net sale = bills less returns.', 'उतना ही समय: {now} बनाम {before}। कुल बिक्री = बिल घटा वापसी।', 'একই সময়: {now} বনাম {before}। নিট বিক্রি = বিল বাদ ফেরত।', 'Utna hi samay: {now} vs {before}. Net sale = bill minus wapsi.', 'Ekoi somoy: {now} vs {before}. Net bikri = bill bad ferot.'),
  marginNote: w('Before tax; returns not taken off; medicines with under ₹100 of sale left out.', 'टैक्स से पहले; वापसी नहीं घटाई; ₹100 से कम बिक्री वाली दवाएँ छोड़ दीं।', 'ট্যাক্সের আগে; ফেরত বাদ দেওয়া হয়নি; ₹100-এর কম বিক্রির ওষুধ বাদ।', 'Tax se pehle; wapsi nahi ghatai; ₹100 se kam bikri wali dawayein chhod di.', 'Tax-er age; ferot bad deoa hoyni; ₹100-er kom bikrir oshudh bad.'),
  buyNote: w('Each supplier’s last price per pack in the last {n} days, after discount and free goods. Could save = all of it bought at the cheapest last price.', 'पिछले {n} दिन में हर सप्लायर का आख़िरी दाम प्रति पैक, छूट और फ़्री माल के बाद। बच सकता था = सारा माल सबसे सस्ते आख़िरी दाम पर।', 'গত {n} দিনে প্রতিটি সাপ্লায়ারের শেষ দাম প্রতি প্যাকে, ছাড় আর ফ্রি মাল ধরে। বাঁচত = সব মাল সবচেয়ে সস্তা শেষ দামে কিনলে।', 'Pichhle {n} din mein har supplier ka aakhri daam per pack, chhoot aur free maal ke baad. Bach sakta tha = saara maal sabse saste aakhri daam par.', 'Goto {n} dine protiti supplier-er shesh dam proti pack-e, chhar ar free mal dhore. Bachto = sob mal sobcheye sosta shesh dame kinle.'),
  busyNote: w('Bills by hour and by weekday, India time.', 'घंटे और वार के हिसाब से बिल, भारत का समय।', 'ঘণ্টা আর বার অনুযায়ী বিল, ভারতের সময়।', 'Ghante aur vaar ke hisaab se bill, Bharat ka samay.', 'Ghonta ar bar onujayi bill, Bharoter somoy.'),
  briefNote: w('Today’s jobs, most urgent first — open the brief for the whole list.', 'आज के काम, सबसे ज़रूरी पहले — पूरी list के लिए brief खोलिए।', 'আজকের কাজ, সবচেয়ে জরুরি আগে — পুরো list-এর জন্য brief খুলুন।', 'Aaj ke kaam, sabse zaroori pehle — poori list ke liye brief kholiye.', 'Ajker kaj, sobcheye joruri age — puro list-er jonno brief khulun.'),
  notInPlan: w('This is in the Pro plan — upgrade in Settings → Plan.', 'यह Pro प्लान में है — Settings → Plan में अपग्रेड कीजिए।', 'এটা Pro প্ল্যানে আছে — Settings → Plan থেকে আপগ্রেড করুন।', 'Yeh Pro plan mein hai — Settings → Plan mein upgrade kijiye.', 'Eta Pro plan-e achhe — Settings → Plan theke upgrade korun.'),
  briefClear: w('Nothing needs you today.', 'आज आपके लिए कोई काम नहीं।', 'আজ আপনার কোনো কাজ নেই।', 'Aaj aapke liye koi kaam nahi.', 'Aaj apnar kono kaj nei.'),
} as const;

export const WEEKDAY: Record<string, Words> = {
  Sunday: w('Sunday', 'रविवार', 'রবিবার', 'Ravivaar', 'Robibar'),
  Monday: w('Monday', 'सोमवार', 'সোমবার', 'Somvaar', 'Sombar'),
  Tuesday: w('Tuesday', 'मंगलवार', 'মঙ্গলবার', 'Mangalvaar', 'Monggolbar'),
  Wednesday: w('Wednesday', 'बुधवार', 'বুধবার', 'Budhvaar', 'Budhbar'),
  Thursday: w('Thursday', 'गुरुवार', 'বৃহস্পতিবার', 'Guruvaar', 'Brihospotibar'),
  Friday: w('Friday', 'शुक्रवार', 'শুক্রবার', 'Shukravaar', 'Shukrobar'),
  Saturday: w('Saturday', 'शनिवार', 'শনিবার', 'Shanivaar', 'Shonibar'),
};

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
  expenses: w('Expenses — {period}', 'खर्च — {period}', 'খরচ — {period}', 'Kharcha — {period}', 'Khoroch — {period}'),
  purchases: w('Purchases — {period}', 'खरीद — {period}', 'কেনাকাটা — {period}', 'Kharid — {period}', 'Kenakata — {period}'),
  price: w('Price — {name}', 'दाम — {name}', 'দাম — {name}', 'Daam — {name}', 'Dam — {name}'),
  dead: w('Not sold in {n} days', '{n} दिन से नहीं बिका', '{n} দিন ধরে বিক্রি হয়নি', '{n} din se nahi bika', '{n} din dhore bikri hoyni'),
  customers: w('Top customers — {period}', 'सबसे बड़े ग्राहक — {period}', 'সেরা গ্রাহক — {period}', 'Sabse bade grahak — {period}', 'Sera grahok — {period}'),
  modes: w('Money in by mode — {period}', 'किस तरह पैसा आया — {period}', 'কীভাবে টাকা এল — {period}', 'Kis tarah paisa aaya — {period}', 'Kibhabe taka elo — {period}'),
  orders: w('Customer orders waiting', 'बाकी ग्राहक ऑर्डर', 'বাকি গ্রাহক অর্ডার', 'Baaki customer order', 'Baki grahok order'),
  gst: w('GST — {month}', 'GST — {month}', 'GST — {month}', 'GST — {month}', 'GST — {month}'),
  staff: w('Sales by staff — {period}', 'स्टाफ़ की बिक्री — {period}', 'স্টাফের বিক্রি — {period}', 'Staff ki bikri — {period}', 'Staff-er bikri — {period}'),
  compare_today: w('Today vs yesterday, same hours', 'आज बनाम कल, उतने ही घंटे', 'আজ বনাম গতকাল, একই সময় পর্যন্ত', 'Aaj vs kal, utne hi ghante', 'Aaj vs gotokal, ekoi somoy porjonto'),
  compare_week: w('This week vs last week, same days', 'यह हफ़्ता बनाम पिछला हफ़्ता, उतने ही दिन', 'এই সপ্তাহ বনাম গত সপ্তাহ, একই দিন পর্যন্ত', 'Yeh hafta vs pichhla hafta, utne hi din', 'Ei saptaho vs goto saptaho, ekoi din porjonto'),
  compare_month: w('This month vs last month, same days', 'यह महीना बनाम पिछला महीना, उतने ही दिन', 'এই মাস বনাম গত মাস, একই দিন পর্যন্ত', 'Yeh mahina vs pichhla mahina, utne hi din', 'Ei mas vs goto mas, ekoi din porjonto'),
  marginsLow: w('Lowest margin — {period}', 'सबसे कम मुनाफ़ा — {period}', 'সবচেয়ে কম লাভ — {period}', 'Sabse kam munafa — {period}', 'Sobcheye kom labh — {period}'),
  marginsHigh: w('Highest margin — {period}', 'सबसे ज़्यादा मुनाफ़ा — {period}', 'সবচেয়ে বেশি লাভ — {period}', 'Sabse zyada munafa — {period}', 'Sobcheye beshi labh — {period}'),
  buyOf: w('Buy price by supplier — {name}', 'सप्लायर के हिसाब से खरीद दाम — {name}', 'সাপ্লায়ার অনুযায়ী কেনা দাম — {name}', 'Supplier ke hisaab se kharid daam — {name}', 'Supplier onujayi kena dam — {name}'),
  cheaper: w('Same medicine, cheaper supplier', 'वही दवा, सस्ता सप्लायर', 'একই ওষুধ, সস্তা সাপ্লায়ার', 'Wahi dawa, sasta supplier', 'Ekoi oshudh, sosta supplier'),
  busy: w('Busiest times — {period}', 'सबसे ज़्यादा भीड़ का समय — {period}', 'সবচেয়ে ভিড়ের সময় — {period}', 'Sabse zyada bheed ka samay — {period}', 'Sobcheye bhirer somoy — {period}'),
  brief: w('Morning brief', 'सुबह की brief', 'সকালের brief', 'Subah ki brief', 'Sokaler brief'),
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
  entries: w('Entries', 'एंट्री', 'এন্ট্রি', 'Entries', 'Entry'),
  purchaseTotal: w('Bought for', 'कुल खरीद', 'মোট কেনা', 'Kul kharid', 'Mot kena'),
  paid: w('Paid', 'दे दिया', 'দেওয়া হয়েছে', 'De diya', 'Deoa hoyechhe'),
  stillOwe: w('Still to pay', 'अभी देना है', 'এখনও দিতে হবে', 'Abhi dena hai', 'Ekhono dite hobe'),
  gstRate: w('GST', 'GST', 'GST', 'GST', 'GST'),
  per: w('MRP per {unit}', 'MRP प्रति {unit}', 'MRP প্রতি {unit}', 'MRP per {unit}', 'MRP proti {unit}'),
  lastSold: w('Last sold', 'आख़िरी बार बिका', 'শেষ বিক্রি', 'Aakhri baar bika', 'Shesh bikri'),
  never: w('Never sold', 'कभी नहीं बिका', 'কখনও বিক্রি হয়নি', 'Kabhi nahi bika', 'Kokhono bikri hoyni'),
  outTax: w('GST on sales', 'बिक्री पर GST', 'বিক্রির GST', 'Sale par GST', 'Bikrir GST'),
  inTax: w('GST paid on purchases', 'खरीद पर दिया GST', 'কেনায় দেওয়া GST', 'Kharid par diya GST', 'Kenay deoa GST'),
  net: w('GST to pay', 'देना GST', 'দিতে হবে GST', 'Dena GST', 'Dite hobe GST'),
  credit: w('GST credit left', 'बचा GST क्रेडिट', 'বাকি GST ক্রেডিট', 'Bacha GST credit', 'Baki GST credit'),
  waiting: w('Waiting', 'बाकी', 'বাকি', 'Baaki', 'Baki'),
  ready: w('Ready to bill', 'बिल के लिए तैयार', 'বিলের জন্য তৈরি', 'Bill ke liye taiyaar', 'Bill-er jonno toiri'),
  stale: w('Waiting over a week', 'हफ़्ते से ज़्यादा से', 'এক সপ্তাহের বেশি', 'Hafte se zyada se', 'Ek saptaher beshi'),
  advance: w('Advance held', 'जमा एडवांस', 'জমা অগ্রিম', 'Jama advance', 'Joma agrim'),
  moneyIn: w('Money in', 'कुल आया', 'মোট এল', 'Kul aaya', 'Mot elo'),
  costValue: w('Value at cost', 'लागत पर कीमत', 'খরচে দাম', 'Laagat par value', 'Khoroche dam'),
  expected: w('Should be in the drawer', 'गल्ले में होना चाहिए', 'ক্যাশে থাকা উচিত', 'Galle mein hona chahiye', 'Cash-e thaka uchit'),
  before: w('before', 'पहले', 'আগে', 'pehle', 'age'),
  couldSave: w('Could save', 'बच सकता था', 'বাঁচত', 'Bach sakta tha', 'Bachto'),
  ySale: w('Yesterday’s net sale', 'कल की कुल बिक्री', 'গতকালের নিট বিক্রি', 'Kal ki net sale', 'Gotokaler net bikri'),
  yBills: w('Yesterday’s bills', 'कल के बिल', 'গতকালের বিল', 'Kal ke bill', 'Gotokaler bill'),
  vsUsual: w('Against a usual day like it', 'आम दिन के मुकाबले', 'সাধারণ দিনের তুলনায়', 'Aam din ke mukable', 'Sadharon diner tulonay'),
} as const;

export const MODE: Record<string, Words> = {
  CASH: w('Cash', 'नकद', 'নগদ', 'Cash', 'Nogod'),
  UPI: w('UPI', 'UPI', 'UPI', 'UPI', 'UPI'),
  CARD: w('Card', 'कार्ड', 'কার্ড', 'Card', 'Card'),
  CREDIT: w('Udhaar', 'उधार', 'বাকি', 'Udhaar', 'Baki'),
  ADVANCE: w('Order advance', 'ऑर्डर का एडवांस', 'অর্ডারের অগ্রিম', 'Order advance', 'Order-er agrim'),
  POINTS: w('Loyalty points', 'पॉइंट', 'পয়েন্ট', 'Points', 'Point'),
  CREDIT_NOTE: w('Credit note (exchange)', 'क्रेडिट नोट (बदली)', 'ক্রেডিট নোট (বদল)', 'Credit note (badli)', 'Credit note (bodol)'),
};

export type ChipGroup = { key: 'sales' | 'money' | 'stock' | 'people'; title: string; qs: string[] };

/** Ready questions for the chat, in groups — each one is answered by the free layer (smoke:ask checks every one). */
export const CHIP_GROUPS: Record<Lang, ChipGroup[]> = {
  en: [
    { key: 'sales', title: 'Sales', qs: ['Today’s sale', 'Yesterday’s sale', 'This week’s sale', 'Top sellers this month', 'UPI and card today', 'This month vs last month', 'Busiest time of day'] },
    { key: 'money', title: 'Money', qs: ['This month’s profit', 'Expenses this month', 'Purchases this month', 'GST this month', 'Cash in the drawer today', 'Lowest margin medicines', 'Which supplier is cheaper'] },
    { key: 'stock', title: 'Stock', qs: ['Running low on stock', 'Expiring in 30 days', 'Expired stock', 'Not selling for 60 days', 'Stock value'] },
    { key: 'people', title: 'People', qs: ['Udhaar to collect', 'Top customers this month', 'How much to pay suppliers', 'Which staff sold the most this month', 'Pending customer orders'] },
  ],
  hi: [
    { key: 'sales', title: 'बिक्री', qs: ['आज की बिक्री', 'कल की बिक्री', 'इस हफ़्ते की बिक्री', 'इस महीने सबसे ज़्यादा क्या बिका', 'आज UPI और कार्ड से कितना आया', 'इस महीने बनाम पिछला महीना', 'किस समय सबसे ज़्यादा ग्राहक आते हैं'] },
    { key: 'money', title: 'पैसा', qs: ['इस महीने का मुनाफ़ा', 'इस महीने का खर्च', 'इस महीने की खरीद', 'इस महीने का GST', 'आज गल्ले में कितना नकद', 'सबसे कम मुनाफ़े वाली दवाएँ', 'कौन सा सप्लायर सस्ता है'] },
    { key: 'stock', title: 'स्टॉक', qs: ['कम स्टॉक', '30 दिन में एक्सपायरी', 'एक्सपायर्ड स्टॉक', '60 दिन से नहीं बिका', 'स्टॉक की कीमत'] },
    { key: 'people', title: 'लोग', qs: ['कुल उधार कितना है', 'इस महीने सबसे ज़्यादा खरीदने वाले ग्राहक', 'सप्लायर को कितना देना है', 'इस महीने किसने सबसे ज़्यादा बेचा', 'पेंडिंग ऑर्डर'] },
  ],
  bn: [
    { key: 'sales', title: 'বিক্রি', qs: ['আজকের বিক্রি', 'গতকালের বিক্রি', 'এই সপ্তাহের বিক্রি', 'এই মাসে সবচেয়ে বেশি কী বিক্রি হলো', 'আজ UPI আর কার্ডে কত এল', 'এই মাস বনাম গত মাস', 'কোন সময়ে সবচেয়ে বেশি খদ্দের আসে'] },
    { key: 'money', title: 'টাকা', qs: ['এই মাসের লাভ', 'এই মাসের খরচ', 'এই মাসের কেনাকাটা', 'এই মাসের GST', 'আজ ক্যাশে কত নগদ', 'সবচেয়ে কম লাভের ওষুধ', 'কোন সাপ্লায়ার সস্তা'] },
    { key: 'stock', title: 'স্টক', qs: ['কম স্টক', '30 দিনে মেয়াদ শেষ', 'মেয়াদ শেষ স্টক', '60 দিন ধরে বিক্রি হয়নি', 'স্টকের দাম'] },
    { key: 'people', title: 'মানুষ', qs: ['মোট বাকি কত', 'এই মাসে সবচেয়ে বেশি কেনা গ্রাহক', 'সাপ্লায়ারকে কত দিতে হবে', 'এই মাসে কোন স্টাফ সবচেয়ে বেশি বিক্রি করল', 'পেন্ডিং অর্ডার'] },
  ],
};

/** Questions only the AI can answer (a token each): open advice — v1.30 moved the fixed-logic ones to free cards. */
export const AI_GROUP: Record<Lang, { title: string; qs: string[] }> = {
  en: { title: 'AI advice', qs: ['How can I grow my sales this month?', 'Why did my sales change this month?', 'What should I stock more of?', 'Suggest ways to cut my expenses', 'What should I do first today?'] },
  hi: { title: 'AI सलाह', qs: ['इस महीने बिक्री कैसे बढ़ाऊँ?', 'इस महीने बिक्री क्यों बदली?', 'कौन सा माल ज़्यादा रखना चाहिए — सलाह दीजिए', 'खर्च कैसे कम करूँ?', 'आज पहले क्या करूँ?'] },
  bn: { title: 'AI পরামর্শ', qs: ['এই মাসে বিক্রি কীভাবে বাড়াব?', 'এই মাসে বিক্রি কেন বদলাল?', 'কোন মাল বেশি রাখা উচিত — পরামর্শ দিন', 'খরচ কীভাবে কমাব?', 'আজ প্রথমে কী করব?'] },
};

/** The same questions in one list (the quick chips under an answer use the first few). */
export const CHIPS: Record<Lang, string[]> = { en: CHIP_GROUPS.en.flatMap((g) => g.qs), hi: CHIP_GROUPS.hi.flatMap((g) => g.qs), bn: CHIP_GROUPS.bn.flatMap((g) => g.qs) };
