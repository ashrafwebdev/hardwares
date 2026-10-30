'use strict';

// India-specific rules: GSTIN, state codes, GST split (CGST/SGST or IGST),
// financial year (April to March), invoice numbering and amounts in words.
//
// GST rates are not fixed here. They are revised by notification, so every
// product carries its own rate. The options in GST_RATE_OPTIONS are only the
// slabs offered in the screens; confirm the rate for each HSN code with your CA.

const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'],
  ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
  ['97', 'Other Territory'],
].map(([code, name]) => ({ code, name }));

const STATE_NAMES = Object.fromEntries(STATES.map((s) => [s.code, s.name]));
const GST_RATE_OPTIONS = [0, 0.25, 3, 5, 12, 18, 28];

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Check character of a GSTIN (the 15th), from the first 14 characters.
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

function isValidGstin(value) {
  const g = String(value || '').toUpperCase();
  return GSTIN_PATTERN.test(g) && STATE_NAMES[g.slice(0, 2)] !== undefined && gstinCheckChar(g.slice(0, 14)) === g[14];
}

const stateOfGstin = (gstin) => (gstin ? String(gstin).slice(0, 2) : null);

function isValidPan(value) {
  return PAN_PATTERN.test(String(value || '').toUpperCase());
}

// Split a tax amount (cents) into CGST and SGST for in-state supplies, or IGST for inter-state.
// Odd paise go to SGST so the two halves always add back to the tax.
function splitTax(tax, interstate) {
  if (interstate) return { cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.floor(tax / 2);
  return { cgst, sgst: tax - cgst, igst: 0 };
}

// Split a line amount (cents) into taxable value and tax.
// inclusive = true means the amount already contains GST (MRP-style pricing).
function splitAmount(amount, rate, inclusive) {
  if (inclusive) {
    const taxable = Math.round((amount * 100) / (100 + rate));
    return { taxable, tax: amount - taxable };
  }
  return { taxable: amount, tax: Math.round((amount * rate) / 100) };
}

// Indian financial year runs 1 April to 31 March. Label: '26-27' for 2026-04-01 to 2027-03-31.
function financialYear(isoDate) {
  const [year, month] = String(isoDate).split('-').map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

function financialYearRange(label) {
  const start = 2000 + Number(String(label).slice(0, 2));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function threeDigits(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}

// Indian grouping: crore (1,00,00,000), lakh (1,00,000), thousand, hundreds.
function indianWords(n) {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

// Amount in cents to words, as printed on Indian invoices: "Rupees ... and ... Paise Only".
function amountInWords(cents) {
  const rupees = Math.floor(cents / 100);
  const paise = cents % 100;
  const words = `Rupees ${indianWords(rupees)}`;
  return `${words}${paise ? ` and ${twoDigits(paise)} Paise` : ''} Only`;
}

module.exports = {
  STATES,
  STATE_NAMES,
  GST_RATE_OPTIONS,
  isValidGstin,
  isValidPan,
  stateOfGstin,
  splitTax,
  splitAmount,
  financialYear,
  financialYearRange,
  amountInWords,
  gstinCheckChar,
};
