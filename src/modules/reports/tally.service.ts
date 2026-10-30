import { Types } from 'mongoose';
import type { TenantContext } from '../../core/middleware/tenant';
import { istIsoDay } from '../../utils/date';
import { CustomerModel, CustomerPaymentModel } from '../customers/customer.model';
import { ExpenseModel } from '../expenses/expense.model';
import { OrderModel } from '../orders/order.model';
import { PurchaseModel, PurchaseReturnModel, SupplierPaymentModel } from '../purchases/purchase.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { SupplierModel } from '../suppliers/supplier.model';
import { splitTax } from './catalog';

// One month as Tally (TallyPrime / ERP 9) accounting vouchers: every voucher balances to the paisa, a bill or purchase
// cancelled in a later month stays in its own month and is reversed in the month it was cancelled.

const IST = 5.5 * 60 * 60 * 1000;

export type Group = 'Cash-in-Hand' | 'Bank Accounts' | 'Sales Accounts' | 'Purchase Accounts' | 'Duties & Taxes' | 'Indirect Expenses' | 'Indirect Incomes' | 'Current Liabilities' | 'Sundry Debtors' | 'Sundry Creditors';
type Head = 'Central Tax' | 'State Tax' | 'Integrated Tax';
interface Ledger { name: string; group: Group; head?: Head; gstin?: string }
type Kind = 'Sales' | 'Credit Note' | 'Purchase' | 'Debit Note' | 'Payment' | 'Receipt' | 'Journal';
export const WHAT = ['Bills', 'Bills cancelled from earlier months', 'Customer returns', 'Purchases', 'Purchases cancelled from earlier months', 'Returns to suppliers', 'Supplier payments', 'Udhaar received', 'Expenses', 'Order advances'] as const;
type What = (typeof WHAT)[number];
/** Amount in paise: more than 0 is a debit, less than 0 a credit. */
type Entry = { ledger: string; amount: number };
interface Voucher { id: string; kind: Kind; what: What; date: Date; number: string; party: string; narration: string; lines: Entry[] }

const FIXED = {
  cash: { name: 'Cash', group: 'Cash-in-Hand' },
  bank: { name: 'Bank', group: 'Bank Accounts' },
  outC: { name: 'Output CGST', group: 'Duties & Taxes', head: 'Central Tax' },
  outS: { name: 'Output SGST', group: 'Duties & Taxes', head: 'State Tax' },
  outI: { name: 'Output IGST', group: 'Duties & Taxes', head: 'Integrated Tax' },
  inC: { name: 'Input CGST', group: 'Duties & Taxes', head: 'Central Tax' },
  inS: { name: 'Input SGST', group: 'Duties & Taxes', head: 'State Tax' },
  inI: { name: 'Input IGST', group: 'Duties & Taxes', head: 'Integrated Tax' },
  round: { name: 'Round Off', group: 'Indirect Expenses' },
  points: { name: 'Loyalty points used', group: 'Indirect Expenses' },
  advances: { name: 'Customer advances', group: 'Current Liabilities' },
  notes: { name: 'Customer credit notes', group: 'Current Liabilities' },
  kept: { name: 'Advances kept', group: 'Indirect Incomes' },
  diff: { name: 'Counter difference', group: 'Indirect Incomes' },
} as const satisfies Record<string, Ledger>;

const last4 = (phone: string) => phone.replace(/\D/g, '').slice(-4);
const partyName = (name: string, phone: string) => (last4(phone) ? `${name} (${last4(phone)})` : name);

function book() {
  const ledgers = new Map<string, Ledger>();
  const vouchers: Voucher[] = [];
  const use = (l: Ledger) => {
    const had = ledgers.get(l.name);
    if (!had) ledgers.set(l.name, l);
    // An expense named like one of ours ("Cash") gets its own ledger.
    else if (had.group !== l.group) return use({ ...l, name: `${l.name} (${l.group === 'Indirect Expenses' ? 'expense' : l.group})` });
    return l.name;
  };
  const money = (mode: string | null | undefined) => use(mode === 'CASH' || !mode ? FIXED.cash : FIXED.bank);
  const add = (v: Omit<Voucher, 'lines'>, entries: Entry[]) => {
    const merged = new Map<string, number>();
    for (const e of entries) merged.set(e.ledger, (merged.get(e.ledger) ?? 0) + e.amount);
    const lines = [...merged.entries()].map(([ledger, amount]) => ({ ledger, amount })).filter((e) => e.amount !== 0);
    // What is left is the bill's own round off (rupee rounding, tax split paise).
    const off = -lines.reduce((a, e) => a + e.amount, 0);
    if (off) {
      const r = lines.find((e) => e.ledger === FIXED.round.name);
      if (r) r.amount += off;
      else lines.push({ ledger: use(FIXED.round), amount: off });
    }
    if (lines.some((e) => e.amount)) vouchers.push({ ...v, lines: lines.filter((e) => e.amount !== 0) });
  };
  return { ledgers, vouchers, use, money, add };
}

type Rated = { gstRate: number; taxable: number }[];
const byRate = (lines: Rated) => {
  const m = new Map<number, number>();
  for (const l of lines) m.set(l.gstRate, (m.get(l.gstRate) ?? 0) + l.taxable);
  return [...m.entries()];
};

export async function tallyMonth(t: TenantContext, month: string) {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - IST);
  const next = new Date(Date.UTC(y, m, 1) - IST);
  const shopId = t.shopId;
  const inMonth = { $gte: from, $lt: next };
  const live = { $or: [{ status: { $ne: 'cancelled' as const } }, { cancelledAt: { $gte: next } }] };
  const [sales, cancelledSales, returns, purchases, cancelledPurchases, purReturns, supPays, custPays, expenses, orders] = await Promise.all([
    SaleModel.find({ shopId, billDate: inMonth, ...live }).sort({ billDate: 1, _id: 1 }).lean(),
    SaleModel.find({ shopId, status: 'cancelled', cancelledAt: inMonth, billDate: { $lt: from } }).sort({ cancelledAt: 1 }).lean(),
    SaleReturnModel.find({ shopId, returnDate: inMonth }).sort({ returnDate: 1, _id: 1 }).lean(),
    PurchaseModel.find({ shopId, invoiceDate: inMonth, ...live }).sort({ invoiceDate: 1, _id: 1 }).lean(),
    PurchaseModel.find({ shopId, status: 'cancelled', cancelledAt: inMonth, invoiceDate: { $lt: from } }).sort({ cancelledAt: 1 }).lean(),
    PurchaseReturnModel.find({ shopId, returnDate: inMonth }).sort({ returnDate: 1, _id: 1 }).lean(),
    SupplierPaymentModel.find({ shopId, paymentDate: inMonth }).sort({ paymentDate: 1, _id: 1 }).lean(),
    CustomerPaymentModel.find({ shopId, paymentDate: inMonth }).sort({ paymentDate: 1, _id: 1 }).lean(),
    ExpenseModel.find({ shopId, status: 'active', date: inMonth }).sort({ date: 1, _id: 1 }).lean(),
    OrderModel.find({ shopId, $or: [{ createdAt: inMonth }, { completedAt: inMonth }, { 'refund.at': inMonth }, { 'kept.at': inMonth }] }).sort({ createdAt: 1 }).lean(),
  ]);

  const custIds = new Set<string>();
  for (const s of [...sales, ...cancelledSales]) if (s.customerId && s.payments.some((p) => p.mode === 'CREDIT')) custIds.add(String(s.customerId));
  for (const r of returns) if (r.customerId && r.adjusted) custIds.add(String(r.customerId));
  for (const p of custPays) custIds.add(String(p.customerId));
  const supIds = new Set([...purchases, ...cancelledPurchases, ...purReturns, ...supPays].map((x) => String(x.supplierId)));
  const retPurIds = purReturns.flatMap((r) => (r.purchaseId ? [r.purchaseId] : []));
  const [customers, suppliers, retPurchases] = await Promise.all([
    CustomerModel.find({ shopId, _id: { $in: [...custIds].map((id) => new Types.ObjectId(id)) } }).select('name phone').lean(),
    SupplierModel.find({ shopId, _id: { $in: [...supIds].map((id) => new Types.ObjectId(id)) } }).select('name phone gstin').lean(),
    PurchaseModel.find({ shopId, _id: { $in: retPurIds } }).select('igst').lean(),
  ]);
  const custOf = new Map(customers.map((c) => [String(c._id), c]));
  const supOf = new Map(suppliers.map((s) => [String(s._id), s]));
  const interstate = new Set(retPurchases.filter((p) => p.igst > 0).map((p) => String(p._id)));

  const b = book();
  const customer = (id: unknown, name: string, phone = '') => {
    const c = custOf.get(String(id));
    return b.use({ name: partyName(c?.name ?? name, c?.phone ?? phone), group: 'Sundry Debtors' });
  };
  const supplier = (id: unknown, name: string) => {
    const s = supOf.get(String(id));
    return b.use({ name: s?.name ?? name, group: 'Sundry Creditors', ...(s?.gstin ? { gstin: s.gstin } : {}) });
  };

  type SaleDoc = (typeof sales)[number];
  const saleEntries = (s: SaleDoc): Entry[] => {
    const pay: Entry[] = s.payments.map((p) => ({
      ledger: p.mode === 'CREDIT' ? customer(s.customerId, s.customerName, s.customerPhone) : p.mode === 'POINTS' ? b.use(FIXED.points) : p.mode === 'ADVANCE' ? b.use(FIXED.advances) : p.mode === 'CREDIT_NOTE' ? b.use(FIXED.notes) : b.money(p.mode),
      amount: p.amount,
    }));
    // D104: an offline bill paid a different sum — the owner was told; the books show it apart.
    const diff = s.offline?.paidDiff ? [{ ledger: b.use(FIXED.diff), amount: -s.offline.paidDiff }] : [];
    return [
      ...pay,
      ...diff,
      ...byRate(s.lines.map((l) => ({ gstRate: l.gstRate, taxable: l.taxableAmount }))).map(([rate, taxable]) => ({ ledger: b.use({ name: `Sales GST ${String(rate)}%`, group: 'Sales Accounts' }), amount: -taxable })),
      { ledger: b.use(FIXED.outC), amount: -s.cgst },
      { ledger: b.use(FIXED.outS), amount: -s.sgst },
      ...(s.igst ? [{ ledger: b.use(FIXED.outI), amount: -s.igst }] : []),
    ];
  };
  const saleParty = (s: SaleDoc) => {
    if (s.payments.some((p) => p.mode === 'CREDIT')) return customer(s.customerId, s.customerName, s.customerPhone);
    const modes = new Set(s.payments.map((p) => (p.mode === 'CASH' ? 'CASH' : 'BANK')));
    return modes.size === 1 && modes.has('BANK') ? b.use(FIXED.bank) : b.use(FIXED.cash);
  };
  const who = (s: { customerName: string; buyerGstin?: string | null }) => `${s.customerName && s.customerName !== 'Walk-in' ? ` · ${s.customerName}` : ''}${s.buyerGstin ? ` · GSTIN ${s.buyerGstin}` : ''}`;

  for (const s of sales) {
    b.add({ id: `sale-${String(s._id)}`, kind: 'Sales', what: 'Bills', date: s.billDate, number: s.billNumber, party: saleParty(s), narration: `Bill ${s.billNumber}${who(s)}` }, saleEntries(s));
    if (s.noteBack?.amount) {
      b.add({ id: `noteback-${String(s._id)}`, kind: 'Payment', what: 'Customer returns', date: s.billDate, number: `${s.billNumber}-CN`, party: b.money(s.noteBack.mode), narration: `Credit note balance given back on bill ${s.billNumber}${who(s)}` }, [
        { ledger: b.use(FIXED.notes), amount: s.noteBack.amount },
        { ledger: b.money(s.noteBack.mode), amount: -s.noteBack.amount },
      ]);
    }
  }
  for (const s of cancelledSales) {
    b.add({ id: `salecancel-${String(s._id)}`, kind: 'Credit Note', what: 'Bills cancelled from earlier months', date: s.cancelledAt ?? s.billDate, number: `${s.billNumber}-X`, party: saleParty(s), narration: `Bill ${s.billNumber} of ${istIsoDay(s.billDate)} cancelled${s.cancelReason ? `: ${s.cancelReason}` : ''}` }, saleEntries(s).map((e) => ({ ...e, amount: -e.amount })));
  }

  for (const r of returns) {
    const restored = r.loyaltyRestoredValue ?? 0;
    const out: Entry[] = [];
    if (r.cashBack) out.push({ ledger: b.money('CASH'), amount: -r.cashBack });
    if (r.upiBack) out.push({ ledger: b.money('UPI'), amount: -r.upiBack });
    if (r.adjusted) out.push({ ledger: customer(r.customerId, r.customerName, r.customerPhone), amount: -r.adjusted });
    if (restored) out.push({ ledger: b.use(FIXED.points), amount: -restored });
    const rest = r.total - restored - r.cashBack - r.upiBack - r.adjusted;
    if (rest > 0) out.push({ ledger: r.refundMode === 'CREDIT_NOTE' ? b.use(FIXED.notes) : b.money(r.refundMode === 'UPI' ? 'UPI' : 'CASH'), amount: -rest });
    const party = r.refundMode === 'ADJUST_CREDIT' ? customer(r.customerId, r.customerName, r.customerPhone) : r.refundMode === 'CREDIT_NOTE' ? b.use(FIXED.notes) : b.money(r.refundMode);
    b.add({ id: `return-${String(r._id)}`, kind: 'Credit Note', what: 'Customer returns', date: r.returnDate, number: r.creditNoteNumber ?? r.returnNumber, party, narration: `Return ${r.returnNumber} on bill ${r.billNumber}${who(r)}` }, [
      ...byRate(r.lines.map((l) => ({ gstRate: l.gstRate, taxable: l.taxable }))).map(([rate, taxable]) => ({ ledger: b.use({ name: `Sales GST ${String(rate)}%`, group: 'Sales Accounts' }), amount: taxable })),
      { ledger: b.use(FIXED.outC), amount: r.cgst },
      { ledger: b.use(FIXED.outS), amount: r.sgst },
      ...(r.igst ? [{ ledger: b.use(FIXED.outI), amount: r.igst }] : []),
      ...out,
    ]);
  }

  type PurDoc = (typeof purchases)[number];
  const purEntries = (p: PurDoc): Entry[] => [
    ...byRate(p.lines.map((l) => ({ gstRate: l.gstRate, taxable: l.taxableAmount }))).map(([rate, taxable]) => ({ ledger: b.use({ name: `Purchase GST ${String(rate)}%`, group: 'Purchase Accounts' }), amount: taxable })),
    { ledger: b.use(FIXED.inC), amount: p.cgst },
    { ledger: b.use(FIXED.inS), amount: p.sgst },
    ...(p.igst ? [{ ledger: b.use(FIXED.inI), amount: p.igst }] : []),
    { ledger: supplier(p.supplierId, p.supplierName), amount: -p.grandTotal },
  ];
  for (const p of purchases) {
    b.add({ id: `purchase-${String(p._id)}`, kind: 'Purchase', what: 'Purchases', date: p.invoiceDate, number: p.invoiceNumber, party: supplier(p.supplierId, p.supplierName), narration: `${p.purchaseNumber} · invoice ${p.invoiceNumber} · ${p.supplierName}` }, purEntries(p));
  }
  for (const p of cancelledPurchases) {
    b.add({ id: `purchasecancel-${String(p._id)}`, kind: 'Debit Note', what: 'Purchases cancelled from earlier months', date: p.cancelledAt ?? p.invoiceDate, number: `${p.purchaseNumber}-X`, party: supplier(p.supplierId, p.supplierName), narration: `${p.purchaseNumber} (invoice ${p.invoiceNumber} of ${istIsoDay(p.invoiceDate)}) cancelled${p.cancelReason ? `: ${p.cancelReason}` : ''}` }, purEntries(p).map((e) => ({ ...e, amount: -e.amount })));
  }
  for (const r of purReturns) {
    const tax = splitTax(r.tax, !(r.purchaseId && interstate.has(String(r.purchaseId))));
    b.add({ id: `purreturn-${String(r._id)}`, kind: 'Debit Note', what: 'Returns to suppliers', date: r.returnDate, number: r.creditNoteNumber ?? r.returnNumber, party: supplier(r.supplierId, r.supplierName), narration: `Return ${r.returnNumber}${r.purchaseNumber ? ` of ${r.purchaseNumber}` : ''} · ${r.supplierName} · ${r.reason}` }, [
      { ledger: supplier(r.supplierId, r.supplierName), amount: r.total },
      ...byRate(r.lines.map((l) => ({ gstRate: l.gstRate, taxable: l.amount }))).map(([rate, taxable]) => ({ ledger: b.use({ name: `Purchase GST ${String(rate)}%`, group: 'Purchase Accounts' }), amount: -taxable })),
      { ledger: b.use(FIXED.inC), amount: -tax.cgst },
      { ledger: b.use(FIXED.inS), amount: -tax.sgst },
      ...(tax.igst ? [{ ledger: b.use(FIXED.inI), amount: -tax.igst }] : []),
    ]);
  }
  for (const p of supPays) {
    b.add({ id: `suppay-${String(p._id)}`, kind: 'Payment', what: 'Supplier payments', date: p.paymentDate, number: p.paymentNumber, party: b.money(p.paymentMode), narration: `${p.paymentNumber} · ${p.supplierName} · ${p.paymentMode}${p.referenceNumber ? ` ${p.referenceNumber}` : ''}` }, [
      { ledger: supplier(p.supplierId, p.supplierName), amount: p.amount },
      { ledger: b.money(p.paymentMode), amount: -p.amount },
    ]);
  }
  for (const p of custPays) {
    b.add({ id: `custpay-${String(p._id)}`, kind: 'Receipt', what: 'Udhaar received', date: p.paymentDate, number: p.receiptNumber, party: b.money(p.paymentMode), narration: `${p.receiptNumber} · udhaar from ${p.customerName} · ${p.paymentMode}${p.reference ? ` ${p.reference}` : ''}` }, [
      { ledger: b.money(p.paymentMode), amount: p.amount },
      { ledger: customer(p.customerId, p.customerName), amount: -p.amount },
    ]);
  }
  for (const e of expenses) {
    b.add({ id: `expense-${String(e._id)}`, kind: 'Payment', what: 'Expenses', date: e.date, number: e.expenseNumber, party: b.money(e.paymentMode), narration: [e.expenseNumber, e.category, e.description, e.vendor].filter(Boolean).join(' · ') }, [
      { ledger: b.use({ name: e.category, group: 'Indirect Expenses' }), amount: e.amount },
      { ledger: b.money(e.paymentMode), amount: -e.amount },
    ]);
  }
  const at = (d: Date | null | undefined) => Boolean(d && d >= from && d < next);
  for (const o of orders) {
    const base = { what: 'Order advances' as const, number: o.orderNumber };
    if (o.advance && at(o.createdAt)) b.add({ ...base, id: `advance-${String(o._id)}`, kind: 'Receipt', date: o.createdAt, party: b.money(o.advanceMode), narration: `Advance for order ${o.orderNumber} · ${o.customerName}` }, [{ ledger: b.money(o.advanceMode), amount: o.advance }, { ledger: b.use(FIXED.advances), amount: -o.advance }]);
    if (o.advanceBack && o.completedAt && at(o.completedAt)) b.add({ ...base, id: `advanceback-${String(o._id)}`, kind: 'Payment', date: o.completedAt, party: b.money('CASH'), narration: `Advance above the bill given back · order ${o.orderNumber} · ${o.customerName}` }, [{ ledger: b.use(FIXED.advances), amount: o.advanceBack }, { ledger: b.money('CASH'), amount: -o.advanceBack }]);
    if (o.refund?.amount && at(o.refund.at)) b.add({ ...base, id: `advancerefund-${String(o._id)}`, kind: 'Payment', date: o.refund.at, party: b.money(o.refund.mode), narration: `Advance refunded · order ${o.orderNumber} cancelled · ${o.customerName}` }, [{ ledger: b.use(FIXED.advances), amount: o.refund.amount }, { ledger: b.money(o.refund.mode), amount: -o.refund.amount }]);
    if (o.kept?.amount && at(o.kept.at)) b.add({ ...base, id: `advancekept-${String(o._id)}`, kind: 'Journal', date: o.kept.at, party: b.use(FIXED.advances), narration: `Advance kept · order ${o.orderNumber} cancelled · ${o.customerName}${o.kept.reason ? ` · ${o.kept.reason}` : ''}` }, [{ ledger: b.use(FIXED.advances), amount: o.kept.amount }, { ledger: b.use(FIXED.kept), amount: -o.kept.amount }]);
  }

  const vouchers = b.vouchers.sort((a, c) => a.date.getTime() - c.date.getTime());
  const value = (v: Voucher) => v.lines.reduce((a, e) => a + Math.max(0, e.amount), 0);
  const counts = WHAT.map((what) => {
    const vs = vouchers.filter((v) => v.what === what);
    return { what, n: vs.length, value: vs.reduce((a, v) => a + value(v), 0) };
  }).filter((c) => c.n);
  return { month, from: istIsoDay(from), to: istIsoDay(new Date(next.getTime() - 1)), vouchers, ledgers: [...b.ledgers.values()], counts };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const amt = (paise: number) => (paise / 100).toFixed(2);

const envelope = (report: 'All Masters' | 'Vouchers', body: string[]) =>
  ['<?xml version="1.0" encoding="UTF-8"?>', '<ENVELOPE>', ' <HEADER>', '  <TALLYREQUEST>Import Data</TALLYREQUEST>', ' </HEADER>', ' <BODY>', '  <IMPORTDATA>', '   <REQUESTDESC>', `    <REPORTNAME>${report}</REPORTNAME>`, '   </REQUESTDESC>', '   <REQUESTDATA>', ...body, '   </REQUESTDATA>', '  </IMPORTDATA>', ' </BODY>', '</ENVELOPE>', ''].join('\n');

/** The masters file: every ledger the entries use, under Tally's own groups. */
export function ledgersXml(ledgers: Ledger[]) {
  return envelope(
    'All Masters',
    ledgers.map((l) =>
      [
        '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
        `     <LEDGER NAME="${esc(l.name)}" ACTION="Create">`,
        `      <NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>`,
        `      <PARENT>${esc(l.group)}</PARENT>`,
        ...(l.head ? ['      <TAXTYPE>GST</TAXTYPE>', `      <GSTDUTYHEAD>${l.head}</GSTDUTYHEAD>`] : []),
        ...(l.gstin ? ['      <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>', `      <PARTYGSTIN>${esc(l.gstin)}</PARTYGSTIN>`] : []),
        '     </LEDGER>',
        '    </TALLYMESSAGE>',
      ].join('\n'),
    ),
  );
}

/** The transactions file: debits are negative with ISDEEMEDPOSITIVE Yes, the way Tally writes them. */
export function vouchersXml(vouchers: Voucher[]) {
  return envelope(
    'Vouchers',
    vouchers.map((v) =>
      [
        '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
        `     <VOUCHER REMOTEID="medbox24-${v.id}" VCHTYPE="${v.kind}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
        `      <DATE>${istIsoDay(v.date).replace(/-/g, '')}</DATE>`,
        `      <VOUCHERTYPENAME>${v.kind}</VOUCHERTYPENAME>`,
        `      <VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>`,
        `      <PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>`,
        '      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>',
        `      <NARRATION>${esc(v.narration)}</NARRATION>`,
        ...v.lines.map((e) =>
          [
            '      <ALLLEDGERENTRIES.LIST>',
            `       <LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>`,
            `       <ISDEEMEDPOSITIVE>${e.amount > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
            `       <AMOUNT>${amt(-e.amount)}</AMOUNT>`,
            '      </ALLLEDGERENTRIES.LIST>',
          ].join('\n'),
        ),
        '     </VOUCHER>',
        '    </TALLYMESSAGE>',
      ].join('\n'),
    ),
  );
}
