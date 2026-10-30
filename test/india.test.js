'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createERP } = require('../src/core');
const {
  isValidGstin, isValidPan, splitTax, splitAmount, financialYear, amountInWords, gstinCheckChar,
} = require('../src/core/india');

// A valid GSTIN for a state code, built with the same check-digit rule the GST portal uses.
function gstin(state) {
  const base = `${state}AAPFU0939F1Z`;
  return base + gstinCheckChar(base);
}

let erp;
let warehouseId;
let screws;

beforeEach(() => {
  erp = createERP({ terminalCode: 'ABC' });
  warehouseId = erp.master.listWarehouses()[0].id;
  erp.settings.save({ company_name: 'Test Traders', company_gstin: gstin('27'), company_state_code: '27' });
  screws = erp.master.saveProduct({
    sku: 'SCR-1', name: 'Wood screws box', hsn_code: '7318', price: 11800, cost: 6000, tax_rate: 18,
  });
  erp.inventory.adjustStock({ productId: screws.id, warehouseId, countedQty: 100 });
});
afterEach(() => erp.close());

// ---- GSTIN, PAN and state ------------------------------------------------------

test('GSTIN check digit is validated, so a single typo is caught', () => {
  assert.equal(isValidGstin('27AAPFU0939F1ZV'), true, 'example GSTIN from the GST documentation');
  assert.equal(isValidGstin('27AAPFU0939F1ZA'), false, 'wrong check digit');
  assert.equal(isValidGstin('00AAPFU0939F1ZV'), false, 'state code 00 does not exist');
  assert.equal(isValidGstin('27AAPFU0939F1Z'), false, 'too short');
  assert.equal(isValidGstin(gstin('29')), true);
});

test('PAN format is checked', () => {
  assert.equal(isValidPan('ABCDE1234F'), true);
  assert.equal(isValidPan('ABCDE12345'), false);
});

test('a customer GSTIN fills in the customer state, and a bad GSTIN is refused', () => {
  const bina = erp.master.saveCustomer({ name: 'Bina Builders', gstin: gstin('29') });
  assert.equal(bina.state_code, '29');
  assert.throws(
    () => erp.master.saveCustomer({ name: 'Typo', gstin: gstin('29').slice(0, 14) + 'X' }),
    /GSTIN is not valid/,
  );
});

test('shop settings reject a GSTIN whose state does not match the state setting', () => {
  assert.throws(() => erp.settings.save({ company_gstin: gstin('29') }), /must match the first two digits/);
  assert.throws(() => erp.settings.save({ company_pan: 'ABCDE12' }), /PAN must be 10 characters/);
  assert.throws(() => erp.settings.save({ company_state_code: '99' }), /valid state/);
});

// ---- tax calculation ---------------------------------------------------------------

test('GST-inclusive price is split into taxable value and GST', () => {
  assert.deepEqual(splitAmount(11800, 18, true), { taxable: 10000, tax: 1800 });
  assert.deepEqual(splitAmount(10000, 18, false), { taxable: 10000, tax: 1800 });
  assert.deepEqual(splitTax(1801, false), { cgst: 900, sgst: 901, igst: 0 }, 'odd paisa go to SGST');
  assert.deepEqual(splitTax(1800, true), { cgst: 0, sgst: 0, igst: 1800 });
});

test('a sale within the shop state shows CGST and SGST, each half the GST', () => {
  const sale = erp.sales.createSale({ lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }] });
  assert.equal(sale.subtotal, 10000);
  assert.equal(sale.cgst_total, 900);
  assert.equal(sale.sgst_total, 900);
  assert.equal(sale.igst_total, 0);
  assert.equal(sale.total, 11800);
  assert.equal(sale.is_interstate, 0);
  assert.equal(sale.lines[0].hsn_code, '7318', 'HSN code is printed on the line');
});

test('a sale to another state shows IGST for the full GST', () => {
  const bina = erp.master.saveCustomer({ name: 'Bina Builders', gstin: gstin('29') });
  const sale = erp.sales.createSale({
    customerId: bina.id, lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }],
  });
  assert.equal(sale.is_interstate, 1);
  assert.equal(sale.place_of_supply, '29');
  assert.equal(sale.igst_total, 1800);
  assert.equal(sale.cgst_total, 0);
  assert.equal(sale.sgst_total, 0);
});

test('a customer chosen by state code, without GSTIN, is also treated as inter-state', () => {
  const walkin = erp.master.saveCustomer({ name: 'Karnataka buyer', state_code: '29' });
  const sale = erp.sales.createSale({ customerId: walkin.id, lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }] });
  assert.equal(sale.igst_total, 1800);
});

test('prices can be entered without GST, and GST is then added on top', () => {
  erp.settings.save({ prices_include_gst: false, round_invoice_totals: false });
  const plain = erp.master.saveProduct({ sku: 'PLAIN-1', name: 'Plain item', hsn_code: '7318', price: 10000, tax_rate: 18 });
  erp.inventory.adjustStock({ productId: plain.id, warehouseId, countedQty: 5 });
  const sale = erp.sales.createSale({ lines: [{ productId: plain.id, qty: 1 }], payments: [{ amount: 11800 }] });
  assert.equal(sale.subtotal, 10000);
  assert.equal(sale.total, 11800);
});

test('the invoice total is rounded to the rupee and the difference is shown as round-off', () => {
  const tiny = erp.master.saveProduct({ sku: 'TINY-1', name: 'Washer', hsn_code: '7318', price: 150, tax_rate: 18 });
  erp.inventory.adjustStock({ productId: tiny.id, warehouseId, countedQty: 5 });
  const sale = erp.sales.createSale({ lines: [{ productId: tiny.id, qty: 1 }], payments: [{ amount: 200 }] });
  assert.equal(sale.total, 200);
  assert.equal(sale.round_off, 50);
  assert.equal(sale.due, 0);
});

test('the invoice total is written in rupees and paise', () => {
  const sale = erp.sales.createSale({ lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }] });
  assert.equal(sale.amount_in_words, 'Rupees One Hundred Eighteen Only');
});

// ---- numbering and financial year ----------------------------------------------------

test('invoice numbers restart each financial year (April to March) and fit in 16 characters', () => {
  assert.equal(financialYear('2026-03-31'), '25-26');
  assert.equal(financialYear('2026-04-01'), '26-27');
  const march = erp.sales.createSale({
    date: '2026-03-31', lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }],
  });
  const april = erp.sales.createSale({
    date: '2026-04-01', lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }],
  });
  assert.equal(march.number, 'ABC/25-26/00001');
  assert.equal(april.number, 'ABC/26-27/00001', 'the new year starts again at 1');
  for (const n of [march.number, april.number]) assert.ok(n.length <= 16, `${n} is within 16 characters`);
});

test('credit notes use their own series and are also within 16 characters', () => {
  const sale = erp.sales.createSale({ lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }] });
  const note = erp.sales.createReturn({
    invoiceId: sale.id, lines: [{ productId: screws.id, qty: 1 }], refunds: [{ amount: 11800 }],
  });
  assert.match(note.number, /^C-ABC\/\d{2}-\d{2}\/0001$/);
  assert.ok(note.number.length <= 16);
});

test('a credit note keeps the tax type of the original invoice', () => {
  const bina = erp.master.saveCustomer({ name: 'Bina Builders', gstin: gstin('29') });
  const sale = erp.sales.createSale({
    customerId: bina.id, lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }],
  });
  const note = erp.sales.createReturn({
    invoiceId: sale.id, lines: [{ productId: screws.id, qty: 1 }], refunds: [{ amount: 11800 }],
  });
  assert.equal(note.igst_total, 1800);
  assert.equal(note.cgst_total, 0);
  assert.equal(note.total, 11800);
  assert.equal(erp.inventory.totalStock(screws.id), 100, 'goods came back into stock');
});

test('amounts in words follow the Indian grouping of thousand, lakh and crore', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(5000050), 'Rupees Fifty Thousand and Fifty Paise Only');
  assert.equal(
    amountInWords(123456750),
    'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only',
  );
  assert.equal(amountInWords(10000000 * 100), 'Rupees One Crore Only');
});

// ---- purchases and GST return figures -------------------------------------------------

test('GST paid to an inter-state supplier is recorded as IGST input credit', () => {
  const supplier = erp.master.saveSupplier({ name: 'Sunrise Steel', gstin: gstin('29') });
  const po = erp.purchasing.savePurchase({ supplierId: supplier.id, lines: [{ productId: screws.id, qty: 10, unitCost: 10000 }] });
  erp.purchasing.markOrdered(po.id);
  const received = erp.purchasing.receivePurchase(po.id, { date: '2026-10-15' });
  assert.equal(received.is_interstate, 1);
  assert.equal(received.igst_total, 18000);
  assert.equal(received.total, 118000);
});

test('the GST return figures give outward tax, input credit and the net payable', () => {
  const bina = erp.master.saveCustomer({ name: 'Bina Builders', gstin: gstin('29') });
  const ali = erp.master.saveCustomer({ name: 'Ali Construction', gstin: gstin('27'), credit_limit: 1000000 });
  erp.sales.createSale({ lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }] });
  erp.sales.createSale({ customerId: ali.id, lines: [{ productId: screws.id, qty: 2 }], payments: [] });
  erp.sales.createSale({ customerId: bina.id, lines: [{ productId: screws.id, qty: 1 }], payments: [{ amount: 11800 }] });

  const supplier = erp.master.saveSupplier({ name: 'Sunrise Steel', gstin: gstin('29') });
  const po = erp.purchasing.savePurchase({ supplierId: supplier.id, lines: [{ productId: screws.id, qty: 10, unitCost: 10000 }] });
  erp.purchasing.markOrdered(po.id);
  erp.purchasing.receivePurchase(po.id, { date: '2026-10-15' });

  const gst = erp.reports.gstReturn({ from: '2000-01-01', to: '2100-12-31' });
  assert.equal(gst.outward.taxable, 40000);
  assert.equal(gst.outward.cgst, 2700);
  assert.equal(gst.outward.sgst, 2700);
  assert.equal(gst.outward.igst, 1800);
  assert.equal(gst.outward.tax, 7200);
  assert.equal(gst.input_tax_credit.igst, 18000);
  assert.equal(gst.net_payable, 7200 - 18000, 'negative means credit carried forward');

  assert.equal(gst.hsn.length, 1);
  assert.equal(gst.hsn[0].hsn_code, '7318');
  assert.equal(gst.hsn[0].tax_rate, 18);
  assert.equal(gst.hsn[0].qty, 4);

  assert.equal(gst.b2b_invoices.length, 2, 'invoices to customers with a GSTIN are B2B');
  assert.equal(gst.b2c.invoices, 1, 'the walk-in sale is B2C');
  assert.equal(gst.b2c.total, 11800);
});

test('the HSN summary separates lines by tax rate', () => {
  const fifty = erp.master.saveProduct({ sku: 'SCR-5', name: 'Five percent item', hsn_code: '7318', price: 10500, tax_rate: 5 });
  erp.inventory.adjustStock({ productId: fifty.id, warehouseId, countedQty: 5 });
  erp.sales.createSale({ lines: [{ productId: screws.id, qty: 1 }, { productId: fifty.id, qty: 1 }], payments: [] , customerId: erp.master.saveCustomer({ name: 'Credit', credit_limit: 1000000 }).id });
  const rows = erp.reports.gstReturn({ from: '2000-01-01', to: '2100-12-31' }).hsn;
  assert.deepEqual(rows.map((r) => r.tax_rate), [5, 18]);
});

test('a product without an HSN code is flagged in the HSN summary', () => {
  const nohsn = erp.master.saveProduct({ sku: 'NOHSN', name: 'No code yet', price: 1000, tax_rate: 0 });
  erp.inventory.adjustStock({ productId: nohsn.id, warehouseId, countedQty: 2 });
  erp.sales.createSale({ lines: [{ productId: nohsn.id, qty: 1 }], payments: [{ amount: 1000 }] });
  const row = erp.reports.gstReturn({ from: '2000-01-01', to: '2100-12-31' }).hsn.find((r) => r.tax_rate === 0);
  assert.equal(row.hsn_code, 'Not set');
});

test('HSN codes must be 4, 6 or 8 digits', () => {
  assert.throws(
    () => erp.master.saveProduct({ sku: 'BAD-HSN', name: 'Bad code', hsn_code: '73', price: 1, tax_rate: 0 }),
    /HSN code must be 4, 6 or 8 digits/,
  );
});
