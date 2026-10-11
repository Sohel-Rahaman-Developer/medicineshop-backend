// What the demo shop sells and who it sells to. Expiry is in months from the day the data is made.

type Row = [name: string, company: string, salt: string, strength: string, category: string, schedule: string, gst: number, hsn: string, saleUnit: string, baseUnit: string, pack: number, purchasePack: number, storage: string, expiryMonths: number | null, qty: number, mrp: number, rate: number, rack: string, batch: string];

export const CATALOG: Row[] = [
  ['Dolo 650 Tablet', 'Micro Labs', 'Paracetamol', '650 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 20, 260, 33.5, 23.4, 'A-2-1', 'DL2501'],
  ['Dolo 650 Tablet', 'Micro Labs', 'Paracetamol', '650 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 2, 25, 33.5, 23.4, 'A-2-1', 'DL2409'],
  ['Crocin Advance 500 Tablet', 'GSK', 'Paracetamol', '500 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 18, 160, 20.5, 14.2, 'A-2-2', 'CR6102'],
  ['Pan 40 Tablet', 'Alkem', 'Pantoprazole', '40 mg', 'Tablet', 'H', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 22, 140, 155.4, 118, 'A-1-3', 'PN6012'],
  ['Omez 20 Capsule', 'Dr Reddys', 'Omeprazole', '20 mg', 'Capsule', 'H', 5, '30049099', 'STRIP', 'CAPSULE', 15, 10, 'Normal', 24, 110, 76, 53, 'A-1-1', 'OM2015'],
  ['Rantac 150 Tablet', 'J B Chemicals', 'Ranitidine', '150 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 30, 10, 'Normal', 14, 90, 42, 29, 'A-1-2', 'RT1502'],
  ['Mox 500 Capsule', 'Sun Pharma', 'Amoxicillin', '500 mg', 'Capsule', 'H', 5, '30041010', 'STRIP', 'CAPSULE', 10, 10, 'Normal', 1, 30, 72.5, 51, 'A-3-1', 'MX1123'],
  ['Mox 500 Capsule', 'Sun Pharma', 'Amoxicillin', '500 mg', 'Capsule', 'H', 5, '30041010', 'STRIP', 'CAPSULE', 10, 10, 'Normal', 19, 80, 72.5, 51, 'A-3-1', 'MX1190'],
  ['Azithral 500 Tablet', 'Alembic', 'Azithromycin', '500 mg', 'Tablet', 'H', 5, '30049099', 'STRIP', 'TABLET', 5, 10, 'Normal', 16, 90, 119.5, 82, 'A-3-2', 'AZ2207'],
  ['Augmentin 625 Duo Tablet', 'GSK', 'Amoxicillin + Clavulanic acid', '625 mg', 'Tablet', 'H', 5, '30049099', 'STRIP', 'TABLET', 10, 10, 'Normal', 3, 60, 223.5, 160, 'A-3-3', 'AG7781'],
  ['Allegra 120 Tablet', 'Sanofi', 'Fexofenadine', '120 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 10, 10, 'Normal', 26, 70, 198, 138, 'A-4-1', 'AL1209'],
  ['Montair LC Tablet', 'Cipla', 'Montelukast + Levocetirizine', '10 mg/5 mg', 'Tablet', 'H', 5, '30049099', 'STRIP', 'TABLET', 10, 10, 'Normal', 20, 80, 251, 175, 'A-4-2', 'ML4501'],
  ['Cetzine 10 Tablet', 'Dr Reddys', 'Cetirizine', '10 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 10, 10, 'Normal', 12, 120, 19.5, 13, 'A-4-3', 'CZ1003'],
  ['Alprax 0.25 Tablet', 'Torrent', 'Alprazolam', '0.25 mg', 'Tablet', 'H1', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 15, 40, 45, 28, 'B-1-1', 'AL0425'],
  ['Telma 40 Tablet', 'Glenmark', 'Telmisartan', '40 mg', 'Tablet', 'H', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 30, 120, 248, 172, 'B-2-1', 'TL4410'],
  ['Glycomet GP 1 Tablet', 'USV', 'Glimepiride + Metformin', '1 mg/500 mg', 'Tablet', 'H', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 21, 130, 136, 95, 'B-2-2', 'GG1904'],
  ['Ecosprin 75 Tablet', 'USV', 'Aspirin', '75 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 14, 10, 'Normal', 15, 150, 5.6, 3.6, 'B-2-3', 'EC0753'],
  ['Atorva 10 Tablet', 'Zydus', 'Atorvastatin', '10 mg', 'Tablet', 'H', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 2, 80, 165, 114, 'B-3-1', 'AT1011'],
  ['Thyronorm 50 mcg Tablet', 'Abbott', 'Thyroxine', '50 mcg', 'Tablet', 'H', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 10, 'Normal', 11, 60, 214, 150, 'B-3-2', 'TN5022'],
  ['Huminsulin R 40IU Vial', 'Lilly', 'Human insulin', '40 IU/ml', 'Injection', 'H', 5, '30043110', 'VIAL', 'VIAL', 1, 10, 'Cold', 7, 20, 158, 120, 'FRIDGE-1', 'HR2206'],
  ['Shelcal 500 Tablet', 'Torrent', 'Calcium + Vitamin D3', '500 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 9, 110, 120, 84, 'C-1-1', 'SH1180'],
  ['Becosules Capsule', 'Pfizer', 'Vitamin B complex', '', 'Capsule', 'OTC', 5, '30049099', 'STRIP', 'CAPSULE', 20, 10, 'Normal', 1, 40, 52, 36, 'C-1-2', 'BC2026'],
  ['Becosules Capsule', 'Pfizer', 'Vitamin B complex', '', 'Capsule', 'OTC', 5, '30049099', 'STRIP', 'CAPSULE', 20, 10, 'Normal', 17, 80, 52, 36, 'C-1-2', 'BC2118'],
  ['Limcee 500 Chewable Tablet', 'Abbott', 'Vitamin C', '500 mg', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 10, 120, 26, 18, 'C-1-3', 'LC3307'],
  ['Zincovit Tablet', 'Apex', 'Multivitamin + Zinc', '', 'Tablet', 'OTC', 5, '30049099', 'STRIP', 'TABLET', 15, 10, 'Normal', 13, 80, 110, 77, 'C-1-4', 'ZV1188'],
  ['Benadryl Syrup 100 ml', 'J&J', 'Diphenhydramine', '', 'Syrup', 'OTC', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 24, 'Normal', 8, 40, 143, 101, 'C-2-1', 'BD8812'],
  ['Digene Gel Mint 200 ml', 'Abbott', 'Antacid', '', 'Syrup', 'OTC', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 24, 'Normal', 12, 40, 165, 115, 'C-2-2', 'DG2004'],
  ['Ascoril LS Syrup 100 ml', 'Glenmark', 'Ambroxol + Levosalbutamol', '', 'Syrup', 'H', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 24, 'Normal', 15, 40, 118, 82, 'C-2-3', 'AS1007'],
  ['Cremaffin Plus Syrup 225 ml', 'Abbott', 'Liquid paraffin + Milk of magnesia', '', 'Syrup', 'OTC', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 24, 'Normal', 14, 30, 245, 170, 'C-2-4', 'CF2251'],
  ['ORS Electral Powder 21.8 g', 'FDC', 'Oral rehydration salts', '', 'Powder', 'OTC', 5, '30049099', 'SACHET', 'SACHET', 1, 50, 'Normal', 20, 250, 22, 15, 'C-3-1', 'EL2188'],
  ['Betadine Ointment 20 g', 'Win-Medicare', 'Povidone iodine', '5%', 'Ointment', 'OTC', 5, '30049099', 'TUBE', 'TUBE', 1, 12, 'Normal', 11, 30, 125, 88, 'D-1-2', 'BT3301'],
  ['Soframycin Skin Cream 30 g', 'Sanofi', 'Framycetin', '1%', 'Ointment', 'OTC', 5, '30049099', 'TUBE', 'TUBE', 1, 12, 'Normal', 5, 40, 66, 46, 'D-1-3', 'SF3011'],
  ['Volini Spray 40 g', 'Sun Pharma', 'Diclofenac', '', 'Personal care', 'OTC', 18, '30049099', 'BOTTLE', 'BOTTLE', 1, 12, 'Normal', 10, 30, 199, 140, 'D-1-1', 'VS4004'],
  ['Candid Dusting Powder 100 g', 'Glenmark', 'Clotrimazole', '1%', 'Powder', 'OTC', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 12, 'Normal', 16, 30, 152, 106, 'D-1-4', 'CD1002'],
  ['Moxiflox Eye Drops 5 ml', 'Cipla', 'Moxifloxacin', '0.5%', 'Drops', 'H', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 20, 'Normal', -1, 4, 96, 66, 'D-2-1', 'MF7710'],
  ['Refresh Tears Eye Drops 10 ml', 'Allergan', 'Carboxymethylcellulose', '0.5%', 'Drops', 'OTC', 5, '30049099', 'BOTTLE', 'BOTTLE', 1, 20, 'Normal', 8, 30, 125, 88, 'D-2-2', 'RF1050'],
  ['Dettol Antiseptic Liquid 250 ml', 'Reckitt', '', '', 'Personal care', 'NON_DRUG', 18, '3808', 'BOTTLE', 'BOTTLE', 1, 12, 'Normal', 24, 40, 150, 112, 'E-1-2', 'DT2506'],
  ['Savlon Hand Sanitizer 200 ml', 'ITC', '', '', 'Personal care', 'NON_DRUG', 18, '3808', 'BOTTLE', 'BOTTLE', 1, 12, 'Normal', 14, 40, 100, 72, 'E-1-3', 'SV2003'],
  ["Johnson's Baby Lotion 100 ml", 'J&J', '', '', 'Baby care', 'NON_DRUG', 18, '3304', 'BOTTLE', 'BOTTLE', 1, 12, 'Normal', 15, 20, 185, 140, 'E-1-1', 'JB5501'],
  ['Pampers Baby Pants M 20', 'P&G', '', '', 'Baby care', 'NON_DRUG', 12, '9619', 'PACK', 'PACK', 1, 6, 'Normal', 30, 25, 399, 310, 'E-1-4', 'PB2011'],
  ['Ensure Vanilla 400 g', 'Abbott', '', '', 'Nutrition', 'NON_DRUG', 18, '2106', 'JAR', 'JAR', 1, 6, 'Normal', 12, 35, 790, 620, 'E-2-2', 'EN4007'],
  ['Horlicks Classic Malt 500 g', 'HUL', '', '', 'Nutrition', 'NON_DRUG', 18, '1901', 'JAR', 'JAR', 1, 6, 'Normal', 11, 45, 275, 210, 'E-2-3', 'HL5009'],
  ['Accu-Chek Active Strips 50', 'Roche', '', '', 'Device', 'NON_DRUG', 12, '3822', 'PACK', 'PACK', 1, 10, 'Normal', 7, 20, 1199, 890, 'E-2-4', 'AC5012'],
  ['Omron BP Monitor HEM-7120', 'Omron', '', '', 'Device', 'NON_DRUG', 18, '9018', 'PIECE', 'PIECE', 1, 10, 'Normal', null, 4, 2450, 1800, 'E-2-1', ''],
  ['Dr Morepen Thermometer MT-101', 'Dr Morepen', '', '', 'Device', 'NON_DRUG', 18, '9025', 'PIECE', 'PIECE', 1, 10, 'Normal', null, 40, 199, 120, 'E-2-1', ''],
  ['Hansaplast Washproof 20 strips', 'Beiersdorf', '', '', 'Surgical', 'NON_DRUG', 12, '3005', 'PACK', 'PACK', 1, 20, 'Normal', 28, 50, 50, 34, 'E-3-2', 'HP2033'],
  ['Surgical Gloves (pair)', 'Kanam', '', '', 'Surgical', 'NON_DRUG', 12, '4015', 'PAIR', 'PAIR', 1, 50, 'Normal', 30, 80, 15, 9, 'E-3-1', 'KG1201'],
  ['Cotton Roll 100 g', 'Jaycot', '', '', 'Surgical', 'NON_DRUG', 5, '3005', 'PIECE', 'PIECE', 1, 20, 'Normal', 30, 40, 75, 48, 'E-3-3', 'CT1004'],
  ['Liv 52 Tablet', 'Himalaya', 'Herbal', '', 'Ayurvedic', 'OTC', 12, '30039011', 'BOTTLE', 'BOTTLE', 1, 12, 'Normal', 13, 25, 175, 122, 'F-1-1', 'LV5205'],
  ['Chyawanprash 500 g', 'Dabur', 'Herbal', '', 'Ayurvedic', 'OTC', 12, '30039011', 'JAR', 'JAR', 1, 12, 'Normal', 9, 20, 245, 185, 'F-1-2', 'CH5008'],
  ['Cadbury Dairy Milk Silk 60 g', 'Mondelez', '', '', 'Chocolate & snacks', 'NON_DRUG', 5, '1806', 'BAR', 'BAR', 1, 24, 'Normal', 6, 60, 80, 68, 'COUNTER', 'CDM601'],
  ['Coca-Cola 300 ml Can', 'Coca-Cola', '', '', 'Drinks', 'NON_DRUG', 40, '2202', 'CAN', 'CAN', 1, 24, 'Normal', 5, 72, 40, 30, 'FRIDGE-2', 'CC3001'],
];

/** Template columns of the product import, in order. */
export const IMPORT_KEYS = ['name', 'company', 'salt', 'strength', 'category', 'schedule', 'gst', 'hsn', 'barcode', 'saleUnit', 'baseUnit', 'pack', 'purchaseUnit', 'purchasePack', 'storage', 'hasExpiry', 'batch', 'expiry', 'quantity', 'mrp', 'rate', 'minPrice', 'rack'] as const;

/** name, phone, udhaar limit in paise */
export const CUSTOMERS: [string, string, number][] = [
  ['Anjali Mukherjee', '98301 22410', 300_000], ['Subrata Paul', '98742 11903', 200_000], ['Farida Begum', '90510 66721', 150_000],
  ['Rajesh Agarwal', '98310 44120', 500_000], ['Moumita Dey', '97480 31298', 0], ['Imran Sheikh', '98365 70014', 100_000],
  ['Tapas Chatterjee', '94330 22781', 250_000], ['Priyanka Saha', '98300 99102', 0], ['Gopal Mondal', '96740 18850', 150_000],
  ['Ratna Sen', '98300 12345', 200_000], ['Kakoli Ghosh', '98310 55667', 0], ['Sanjay Gupta', '98311 72290', 300_000],
];

export const SUPPLIERS = [
  { name: 'Mehta Medical Agency', contactPerson: 'Rakesh Mehta', phone: '98312 40011', creditDays: 21, gstin: '19AAKFM4521K1Z3', drugLicense: 'WB/KOL/20B/2207' },
  { name: 'Eastern Pharma Distributors', contactPerson: 'S. Bose', phone: '98300 77120', creditDays: 30, gstin: '', drugLicense: 'WB/KOL/20B/1874' },
  { name: 'Sharma Distributors', contactPerson: 'Anil Sharma', phone: '98311 22334', creditDays: 30, gstin: '19ABCDE1234F1Z5', drugLicense: 'WB/KOL/20B/1189' },
  { name: 'Kolkata Surgicals', contactPerson: '', phone: '98361 55203', creditDays: 7, gstin: '', drugLicense: '' },
];

export const DOCTORS = [
  { name: 'Dr. S. Banerjee', specialization: 'Physician', registrationNumber: 'WBMC 4471' },
  { name: 'Dr. A. Mukherjee', specialization: 'Paediatrics', registrationNumber: 'WBMC 6120' },
  { name: 'Dr. R. Khan', specialization: 'Psychiatry', registrationNumber: 'WBMC 3398' },
];

/** product name prefix, quantity, unit — the H1 basket needs a doctor and patient on the bill. */
export const BASKETS: [string, number, string][][] = [
  [['Dolo 650', 1, 'STRIP'], ['Cetzine 10', 1, 'STRIP']], [['Dolo 650', 2, 'STRIP']], [['Crocin Advance', 2, 'STRIP']], [['Pan 40', 1, 'STRIP'], ['Omez 20', 1, 'STRIP']],
  [['Telma 40', 2, 'STRIP'], ['Ecosprin 75', 2, 'STRIP'], ['Atorva 10', 2, 'STRIP']], [['Glycomet GP 1', 4, 'STRIP'], ['Thyronorm', 1, 'BOTTLE']], [['Telma 40', 4, 'STRIP'], ['Glycomet GP 1', 4, 'STRIP'], ['Shelcal 500', 2, 'STRIP']],
  [['Azithral 500', 1, 'STRIP'], ['Ascoril LS', 1, 'BOTTLE']], [['Augmentin 625', 1, 'STRIP'], ['Becosules', 1, 'STRIP']], [['Shelcal 500', 1, 'STRIP'], ['Limcee 500', 2, 'STRIP']],
  [['Allegra 120', 1, 'STRIP'], ['Montair LC', 1, 'STRIP']], [['ORS Electral', 4, 'SACHET'], ['Dolo 650', 1, 'STRIP']], [['Digene Gel', 1, 'BOTTLE'], ['Rantac 150', 1, 'STRIP']],
  [['Volini Spray', 1, 'BOTTLE'], ['Hansaplast', 1, 'PACK']], [['Dettol Antiseptic', 1, 'BOTTLE'], ['Cotton Roll', 1, 'PIECE']], [['Pampers Baby Pants', 1, 'PACK']],
  [['Ensure Vanilla', 1, 'JAR']], [['Horlicks Classic', 1, 'JAR'], ['Zincovit', 1, 'STRIP']], [['Accu-Chek Active', 1, 'PACK']], [['Liv 52', 1, 'BOTTLE'], ['Chyawanprash', 1, 'JAR']],
  [['Soframycin', 1, 'TUBE'], ['Savlon Hand', 1, 'BOTTLE']], [['Candid Dusting', 1, 'BOTTLE']], [['Refresh Tears', 1, 'BOTTLE']], [['Cremaffin Plus', 1, 'BOTTLE']],
  [['Dr Morepen Thermometer', 1, 'PIECE'], ['Crocin Advance', 1, 'STRIP']], [['Coca-Cola', 2, 'CAN'], ['Cadbury', 1, 'BAR']], [['Benadryl', 1, 'BOTTLE'], ['Cetzine 10', 1, 'STRIP']],
  [['Betadine', 1, 'TUBE'], ['Surgical Gloves', 2, 'PAIR']], [['Mox 500', 1, 'STRIP'], ['Dolo 650', 1, 'STRIP']], [['Huminsulin', 1, 'VIAL']], [["Johnson's", 1, 'BOTTLE']],
  [['Alprax', 1, 'STRIP']],
  // A month of a chronic patient's medicines in one bill.
  [['Telma 40', 4, 'STRIP'], ['Ecosprin 75', 4, 'STRIP'], ['Atorva 10', 2, 'STRIP'], ['Shelcal 500', 2, 'STRIP']],
  [['Glycomet GP 1', 6, 'STRIP'], ['Thyronorm', 1, 'BOTTLE'], ['Zincovit', 2, 'STRIP']],
  [['Augmentin 625', 2, 'STRIP'], ['Pan 40', 2, 'STRIP'], ['Becosules', 1, 'STRIP']],
  [['Ensure Vanilla', 1, 'JAR'], ['Limcee 500', 2, 'STRIP'], ['Shelcal 500', 2, 'STRIP']],
  [['Accu-Chek Active', 1, 'PACK'], ['Glycomet GP 1', 4, 'STRIP']],
  [['Montair LC', 2, 'STRIP'], ['Allegra 120', 1, 'STRIP'], ['Ascoril LS', 1, 'BOTTLE']],
];

/** Restock lines a purchase may bring: product prefix, purchase quantity (sale units), months to expiry. */
export const RESTOCK: [string, number, number][] = [
  ['Dolo 650', 120, 26], ['Crocin Advance', 80, 20], ['Pan 40', 60, 24], ['Telma 40', 80, 30], ['Shelcal 500', 60, 16], ['Glycomet GP 1', 100, 22],
  ['Cetzine 10', 60, 18], ['Ecosprin 75', 80, 20], ['ORS Electral', 100, 22], ['Limcee 500', 60, 14], ['Omez 20', 40, 25], ['Azithral 500', 30, 18],
  ['Atorva 10', 40, 24], ['Augmentin 625', 30, 18], ['Montair LC', 30, 20], ['Ensure Vanilla', 12, 14], ['Accu-Chek Active', 10, 12], ['Thyronorm', 20, 16], ['Ascoril LS', 24, 18],
];

/** Short-dated stock a supplier sent 10 days ago: slow sellers that expire this month and next, for the expiry screens. */
export const SHORT_DATED: [string, number, number][] = [
  ['Cremaffin Plus', 18, 0], ['Refresh Tears', 15, 0], ['Soframycin', 24, 1], ['Candid Dusting', 14, 1], ['Volini Spray', 12, 1],
];
