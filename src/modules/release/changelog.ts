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
