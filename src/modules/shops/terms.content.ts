// Key points shown before signup (PLAN §36.4); the lawyer's full text replaces these later (Q27).
export const TERMS_POINTS = [
  { icon: 'indian-rupee', title: 'Price', body: 'Your price is on the Subscription page and includes 18% GST. A shop can have its own price. A lower price applies from your next payment; a higher one only from 30 days after we tell you. The period you already paid never changes.' },
  { icon: 'sparkles', title: 'Free trial', body: 'Every feature for the trial days, no card needed. When it ends the shop becomes read-only until you choose a plan.' },
  { icon: 'calendar-x', title: 'If the plan ends', body: 'Grace days with full use, then read-only: you can see and download everything, but not bill. Nothing is deleted because a plan ended.' },
  { icon: 'archive', title: 'How long bills stay in full', body: 'By default each financial year stays in full for as long as GST law asks — 72 months after its annual return is due. Your plan can keep it for 10 years instead. After that we keep one line per day (sales, GST by rate, payment modes, returns, purchases, expenses) and delete the bill lines.' },
  { icon: 'bell', title: 'Before anything is deleted', body: 'You are told 90, 30 and 7 days before, and can download that year first. A bill with money still due is never deleted. If you have a GST notice or case, tell us and we hold everything.' },
  { icon: 'scale', title: 'Your records, your duty', body: 'Keeping records for GST, income tax and the Drugs Rules is the shop’s legal duty. MedShop helps by keeping them for the legal minimum and letting you download them any time.' },
  { icon: 'shield-check', title: 'Customer details', body: 'Customer names and phones belong to your shop. MedShop only stores them for you and never uses or shares them.' },
] as const;
