// Newest first. Every release bumps "version" in all three package.json files (backend, frontend, admin) to the top entry.
export interface ReleaseNote {
  version: string;
  date: string;
  title: string;
  shop: string[];
  admin: string[];
  api: string[];
}

export const CHANGELOG: ReleaseNote[] = [
  {
    version: '1.9.0',
    date: '2026-10-10',
    title: 'Feels like an app on the phone',
    shop: [
      'Android’s Back button closes an open sheet or dialog instead of leaving the screen.',
      'On a phone, drag a sheet down by its top to close it.',
      'Pull a screen down from the top to refresh it: only its data is fetched again, nothing typed is lost.',
      'Lists load the next page as you scroll; coming back to a list puts you where you were.',
      'A short buzz on Android when an item goes on the bill, a barcode is read or a bill is saved.',
      'Screens fade in softly (not when the phone is set to reduce motion); “Back online” shows when the network returns.',
    ],
    admin: [],
    api: [],
  },
  {
    version: '1.8.0',
    date: '2026-10-09',
    title: 'Faster and more polished',
    shop: [
      'The app opens faster: about a quarter less to download at the start, and charts load lighter.',
      'Reports over many days (Sales summary, month-wise P&L, Day book) and Stock valuation come back much faster.',
      'Lists stay on screen while you search or change a filter, instead of blinking empty.',
      'A bill from another day shows its date as well as the time (Dashboard, Sales).',
      'Payments read Cash, UPI, Card, Udhaar or Split everywhere; counts read right (1 customer, 1 visit, 1 line).',
      'Charts: dates along the bottom no longer pile up on a phone; the hourly heatmap draws again and suits dark mode.',
      'On a phone the Save button sits above the New bill button; Purchase from bill keeps its bar at the bottom.',
      'POS tiles show product names on two lines; P&L shows dates like 9 Sept – 8 Oct 2026; alerts say “exp Dec 2026”.',
    ],
    admin: ['Lighter to load.'],
    api: [
      'Every shop request checks the sign-in and the shop together (one database round trip, not three); POS search sends its lookups together.',
      'GET /health pings the database and gives db.pingMs; no answer in 3 seconds makes it 503.',
      'proxy-addr 2.0.8 (security fix in Express’s client-IP handling).',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-10-06',
    title: 'Refer a shop',
    shop: [
      'Settings → Plan → Refer a shop: your own code, with Copy, Copy link and WhatsApp.',
      'A new shop that types your code (or opens your link) gets a discount on its first payment, if it pays in time.',
      'You get a discount on your next payment once that shop has paid 3 months in a row — or one year at once. Each shop you bring is one reward.',
      'The discount comes off by itself when you tap Pay, and shows on the plan, the payment and the tax invoice.',
      'Shop setup has an optional Referral code box that says whose code it is before you start.',
    ],
    admin: [
      'Referrals page: turn codes on or off, the new shop’s % and days, the referrer’s % and the months in a row — and every referral with its progress.',
      'Shop page → Referral: its code, who referred it, the shops it brought; Set or Change referrer when an owner forgot the code.',
      'Shops can be found by their referral code.',
    ],
    api: ['GET /referral, GET /referral/check; POST /shops takes referralCode; GET /admin/referrals, PUT /admin/referrals/settings, PUT /admin/shops/:id/referrer.'],
  },
  {
    version: '1.6.2',
    date: '2026-10-06',
    title: 'A compact bill screen, an app-like phone view, a proper rack list',
    shop: [
      'Purchase from bill on a computer: one slim row per line, the box titles (with their ⓘ) once on top — about a third of the height it was.',
      'On a phone or tablet: each line is a short card; tap it and the line opens in a sheet from the bottom — every box, ‹ › to the next line, Done.',
      'Rack boxes (bill, opening stock, product form) show your racks in the app’s own list — type to narrow, arrows and Enter to pick, a new code says it will be created.',
      'Dashboard on a computer: no second “Dashboard” row — the greeting card carries the shop, the range and the time.',
    ],
    admin: [],
    api: [],
  },
  {
    version: '1.6.1',
    date: '2026-10-05',
    title: 'Clearer bill screen, import progress, month picker',
    shop: [
      'Purchase from bill: an ⓘ next to every colour, box (Free, Rate, MRP…), note and button — tap it for the meaning in Bengali.',
      'Excel import shows how far it is (rows saved and %), and locks the screen until it finishes — reload or leaving asks first.',
      'Licence expiry (shop setup and Settings) opens a month grid with the year on top — months already gone can’t be picked.',
      'Add supplier: Credit days says what it means — the bill is due that many days after its date.',
    ],
    admin: [],
    api: ['GET /products/import/progress/:id — rows saved so far of a running import.'],
  },
  {
    version: '1.6.0',
    date: '2026-10-05',
    title: 'Fix a bill before you save it',
    shop: [
      'Purchase from bill: “Search product” on any line — pick any product the shop has, not only the suggestions.',
      'A line matched to the wrong product? “Wrong product? Change” — the line is checked again against the right one.',
      '“Add a line the bill reading missed”: pick a product or add a new one, type batch, expiry, quantity, rate and MRP.',
      'The supplier’s names you fix are remembered for the next bill.',
    ],
    admin: [],
    api: ['POST /purchases/import/preview takes an optional productId per line.'],
  },
  {
    version: '1.5.0',
    date: '2026-10-05',
    title: 'Read any bill with AI',
    shop: [
      'Purchases → From bill → Read with AI: a scan, a phone photo, any PDF or Word file — the lines fill in the same coloured way.',
      'Paid in coins, a few a page; a read that fails gives the coins back.',
      'Settings → AI coins: buy coin packs by UPI or card (GST invoice), see every coin and every AI read.',
      'Bills from the supplier’s software still read free.',
    ],
    admin: [
      'AI bill reading: the Claude API key (sealed, last 4 shown, test button), model, coins a page, coin packs.',
      'Every AI read with its shop, user, file, pages, coins and Anthropic’s real cost; coin sales against cost.',
      'Give or take back a shop’s coins on its page, with a reason.',
    ],
    api: ['POST /purchases/import/ai, /ai/offer, /ai/wallet, /ai/coins/* and /admin/ai/*; coin packs paid through the same Razorpay webhook.'],
  },
  {
    version: '1.4.0',
    date: '2026-10-05',
    title: 'Supplier bills as PDF',
    shop: [
      'Purchases → From bill now reads the PDF the supplier’s billing software makes, as well as Word, Excel and CSV.',
      'Bills laid out in columns, with centred or two-line titles, over several pages, or printed DOS-style all read the same.',
      'A scanned photo or a PDF locked with a password says so plainly — ask the supplier for the file their software makes.',
      'সাহায্য (Help) on the bill screen explains every colour, in Bengali.',
    ],
    admin: [],
    api: ['POST /purchases/import/read takes a PDF — up to 20 pages, about 800 KB. The server needs Node 22.13 or newer.'],
  },
  {
    version: '1.3.0',
    date: '2026-10-05',
    title: 'Purchase straight from the supplier’s bill',
    shop: [
      'Purchases → From bill: upload the supplier’s Word, Excel or CSV bill and every line fills in — PDF next.',
      'Each line is coloured: stock up in a batch you have, a new batch, MRP changed, a new product, or one to check.',
      'Products already in the shop are never added again; new ones are made from the bill. Pick racks if you like, then Confirm & save.',
      'The bill’s own Amount, Net and total are checked — a misread number shows in red.',
      'The next bill from the same supplier is recognised by its names at once.',
    ],
    admin: [],
    api: ['POST /purchases/import/read, /import/preview and /import — read, preview and save a supplier bill in one transaction.'],
  },
  {
    version: '1.2.0',
    date: '2026-10-04',
    title: 'Add a product in one go',
    shop: [
      'Add product is one screen: name, pack, and the batch on your shelf — batch, expiry, quantity and MRP — saved together.',
      'Type the pack as the bill shows it (10×15, 15 TAB, 200 ML) and the units fill in.',
      'Company, purchase rate, rack and the rest are optional. A new rack is added as you type it.',
    ],
    admin: [],
    api: ['POST /products takes the first batch with the product — both are saved, or neither.'],
  },
  {
    version: '1.1.0',
    date: '2026-10-03',
    title: 'Polish after launch',
    shop: [
      'What’s new: see what changed in every update, from your account menu.',
      'Emails redesigned: sign-in code, staff invite, security alert, morning alerts and the evening summary.',
      'Easier to read and tap: darker teal text, bigger ⓘ buttons, clearer labels at the counter for screen readers.',
      'On phones, a message at the bottom no longer blocks taps on the screen behind it.',
    ],
    admin: [
      'New sign-in: code boxes and a QR code for the authenticator.',
      'Idle lock after 15 minutes — unlock with a PIN or the authenticator code. Sign out asks first.',
      'Redesigned console: grouped menu, shop search, overview with a 30-day chart, richer shop page.',
      'Alerts on Messaging & health — server errors, wrong codes, bad webhooks and failed jobs email the super admins.',
      'Releases page: the live version, the last deploy and what changed.',
    ],
    api: [
      'Version and deploy time in /health; release notes at /release.',
      'Failure counters with email alerts.',
      'Security scan fixes: AES-GCM tag length pinned; Nginx no longer forwards Upgrade headers.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-03',
    title: 'MedShop goes live',
    shop: [
      'Billing at the counter, stock and expiry, purchases and suppliers, customers and udhaar, loyalty points.',
      'Reports, GST pages for your CA, day close, plans and online payment.',
      'Download all your photos as one ZIP from Plan & billing → Your data.',
    ],
    admin: ['Platform console: shops, plans and prices, payments and refunds, support access, team and audit log.'],
    api: ['Live at medapi.trackcloud.in on MongoDB Atlas, with a daily encrypted backup.'],
  },
];
