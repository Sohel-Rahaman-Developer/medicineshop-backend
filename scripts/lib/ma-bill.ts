// The M.A. Pharma bill of 1 Sep 2026 (photo from a shop), and a second bill from the same supplier.
export const MA_HEADER = ['Qty', 'Mfr', 'Pack', 'Product Name', 'OMRP', 'MRP', 'Exp', 'HSN', 'Batch', 'Rate', 'DIS', 'SGST', 'CGST', 'Amount', 'Net Amount'];

export const MA_LINES = [
  ['1', 'ADIREX', '200 ML', 'VIRCOCO OIL', '300.00', '300.00', '12/27', '30049099', 'VC-64', '228.58', '6.00', '2.50', '2.50', '228.58', '225.61'],
  ['10', 'GENERIC', '10*3', 'AZIKEM 500 TAB', '80.50', '75.53', '1/28', '30022019', '25443288', '28.19', '0.00', '2.50', '2.50', '281.90', '296.00'],
  ['', '', '', '3 PICE ER PATA DEBE', '', '', '', '', '', '', '', '', '', '', ''],
  ['1', 'GENERIC', '75GM', 'KETOKEM SOAP', '143.00', '127.25', '11/28', '21069099', 'KKS25514ED', '41.50', '0.00', '2.50', '2.50', '41.50', '43.58'],
  ['1', 'ALKEM', '10', 'ALSITA M 50 TAB', '110.15', '110.15', '4/28', '30049099', '26441762', '83.92', '6.00', '2.50', '2.50', '83.92', '82.82'],
  ['1', 'ALKEM', '10*15', 'DAPANORM 10 TAB', '296.70', '296.70', '2/28', '30049099', '26441046', '226.06', '6.00', '2.50', '2.50', '226.06', '223.12'],
  ['3', 'EAST IND', '10 20', 'EQ TAB', '61.00', '61.00', '11/29', '30049099', 'EQ5324', '46.48', '4.00', '2.50', '2.50', '139.44', '140.56'],
  ['1', 'INTAS', '10*15T', 'ZAPTRA 25 CAP', '329.06', '329.06', '4/28', '30049099', 'K2601326', '250.71', '6.00', '2.50', '2.50', '250.71', '247.45'],
  ['5', 'MACLEODS', '10 TAB', 'OMNACORTIL 10 TAB', '12.88', '12.88', '3/30', '30049099', '13260540A', '10.31', '4.00', '2.50', '2.50', '51.55', '51.97'],
  ['2', 'MANKIND', '15 30', 'RIVOTRIL 0.5 TAB', '55.30', '55.30', '4/28', '30049099', '6BAF2008', '42.13', '6.00', '2.50', '2.50', '84.26', '83.16'],
  ['1', 'PIRAMAL', '10 15', 'SUPRADYN DAILY TAB', '75.00', '75.00', '10/27', '30049099', 'MH0056', '57.14', '4.00', '2.50', '2.50', '57.14', '57.59'],
  ['2', 'RANBAXY', '15 TAB', 'ROSUVAS F 10 TAB', '460.00', '460.00', '11/28', '30049099', 'SIH1116A', '350.48', '6.00', '2.50', '2.50', '700.96', '691.84'],
  ['1', 'TABLETI', '10 10', 'BIFILAC HP CAPS', '228.00', '228.00', '2/28', '30049099', 'BLA26S02', '173.71', '6.00', '2.50', '2.50', '173.71', '171.45'],
  ['2', 'USV', '10 TAB', 'GLYCOMET GP 0.5 TAB', '88.88', '88.88', '3/28', '30049099', '60002821', '67.72', '6.00', '2.50', '2.50', '135.44', '133.67'],
  ['', '', '', 'TOTAL', '', '', '', '', '', '', '', '', '', '2455.17', ''],
];

export const MA_TOP = ['M/S M.A.PHARMA', 'Hridaypur, Kolkata · GSTIN 19AAKFM1234B1Z5', 'GST INVOICE · CREDIT', 'Invoice No : A085013', 'Invoice Date : 01-09-2026'];
export const MA_FOOT = ['Please Pay 2449.00', 'Rupees Two Thousand Four Hundred Forty Nine Only', 'Bank: SBI · A/c 30123456789 · IFSC SBIN0001234', 'Goods once sold will not be taken back.'];

/** A week later: the same Azikem batch, a new Dapanorm batch, Rosuvas at a new MRP, and a product the shop never had. */
export const MA2_LINES = [
  ['5', 'GENERIC', '10*3', 'AZIKEM 500 TAB', '75.53', '75.53', '1/28', '30022019', '25443288', '28.19', '0.00', '2.50', '2.50', '140.95', '148.00'],
  ['2', 'ALKEM', '10*15', 'DAPANORM 10 TAB', '296.70', '296.70', '6/28', '30049099', '26449001', '226.06', '6.00', '2.50', '2.50', '452.12', '446.24'],
  ['1', 'RANBAXY', '15 TAB', 'ROSUVAS F 10 TAB', '460.00', '480.00', '11/28', '30049099', 'SIH1116A', '365.71', '6.00', '2.50', '2.50', '365.71', '360.96'],
  ['3', 'SUN', '10*15', 'PANTOCID 40 TAB', '155.00', '155.00', '8/28', '30049099', 'PT2604', '118.10', '4.00', '2.50', '2.50', '354.30', '357.13'],
  ['', '', '', 'TOTAL', '', '', '', '', '', '', '', '', '', '1313.08', ''],
];
export const MA2_TOP = ['M/S M.A.PHARMA', 'Hridaypur, Kolkata · GSTIN 19AAKFM1234B1Z5', 'GST INVOICE · CREDIT', 'Invoice No : A085014', 'Invoice Date : 08-09-2026'];
export const MA2_FOOT = ['Please Pay 1312.00', 'Rupees One Thousand Three Hundred Twelve Only', 'Bank: SBI · A/c 30123456789 · IFSC SBIN0001234', 'Goods once sold will not be taken back.'];

/** The A085013 bill as Claude copies it (D78): items as printed, the note and the TOTAL row as notes. */
export const MA_AI = {
  invoiceNumber: 'A085013',
  invoiceDate: '01-09-2026',
  toPay: '2449.00',
  lines: MA_LINES.filter((r) => r[0]).map(([qty = '', company = '', pack = '', name = '', oldMrp = '', mrp = '', expiry = '', hsn = '', batch = '', rate = '', discount = '', sgst = '0', cgst = '0', amount = '', net = '']) => ({ qty, free: '', company, pack, name, oldMrp, mrp, expiry, hsn, batch, rate, discount, gst: String(Number(sgst) + Number(cgst)), amount, net })),
  notes: ['3 PICE ER PATA DEBE', 'TOTAL 2455.17'],
};
