'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createERP } = require('../src/core');

let erp;
let warehouseId;
let item;

beforeEach(() => {
  erp = createERP({ terminalCode: 'SHP' });
  warehouseId = erp.master.listWarehouses()[0].id;
  erp.settings.save({ company_state_code: '27', round_invoice_totals: false, prices_include_gst: false });
  item = erp.master.saveProduct({ sku: 'NUT-1', name: 'Nuts box', hsn_code: '7318', price: 10000, cost: 5000, tax_rate: 18 });
  erp.inventory.adjustStock({ productId: item.id, warehouseId, countedQty: 50 });
});
afterEach(() => erp.close());

test('a registered shop issues tax invoices by default', () => {
  const sale = erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  assert.equal(sale.gst_applied, 1);
  assert.equal(sale.tax_total, 1800);
});

test('each bill can be a bill of supply, even when the default is tax invoice', () => {
  const plain = erp.sales.createSale({ gst: false, lines: [{ productId: item.id, qty: 2 }], payments: [{ amount: 20000 }] });
  assert.equal(plain.gst_applied, 0);
  assert.equal(plain.tax_total, 0);
  assert.equal(plain.total, 20000, 'the customer pays the price, no GST added');
  assert.equal(plain.lines[0].tax_rate, 0);

  const taxed = erp.sales.createSale({ gst: true, lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  assert.equal(taxed.gst_applied, 1);
  assert.equal(taxed.tax_total, 1800);
});

test('the default for new bills follows the setting', () => {
  erp.settings.save({ gst_billing: false });
  const sale = erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 10000 }] });
  assert.equal(sale.gst_applied, 0);
  const forced = erp.sales.createSale({ gst: true, lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  assert.equal(forced.gst_applied, 1, 'a bill can still be made with tax when the default is off');
});

test('a shop not registered for GST cannot issue a tax invoice, but can issue bills of supply', () => {
  erp.settings.save({ gst_registered: false });
  assert.throws(
    () => erp.sales.createSale({ gst: true, lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] }),
    /not registered for GST/,
  );
  const sale = erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 10000 }] });
  assert.equal(sale.gst_applied, 0, 'an unregistered shop defaults to bills of supply');
});

test('a client-sent tax rate cannot add GST to a bill of supply', () => {
  const sale = erp.sales.createSale({ gst: false, lines: [{ productId: item.id, qty: 1, taxRate: 18 }], payments: [{ amount: 10000 }] });
  assert.equal(sale.tax_total, 0);
});

test('a return on a bill of supply refunds the plain amount with no tax', () => {
  const sale = erp.sales.createSale({ gst: false, lines: [{ productId: item.id, qty: 2 }], payments: [{ amount: 20000 }] });
  const back = erp.sales.createReturn({
    invoiceId: sale.id, lines: [{ productId: item.id, qty: 1 }], refunds: [{ amount: 10000 }],
  });
  assert.equal(back.gst_applied, 0);
  assert.equal(back.total, 10000);
  assert.equal(erp.inventory.totalStock(item.id), 49);
});

test('a return on a tax invoice reverses its GST, whatever the current default', () => {
  const taxed = erp.sales.createSale({ gst: true, lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  erp.settings.save({ gst_billing: false });
  const back = erp.sales.createReturn({
    invoiceId: taxed.id, lines: [{ productId: item.id, qty: 1 }], refunds: [{ amount: 11800 }],
  });
  assert.equal(back.gst_applied, 1);
  assert.equal(back.tax_total, 1800);
});

test('a quote keeps its bill type when converted', () => {
  const quote = erp.sales.createQuote({ gst: false, lines: [{ productId: item.id, qty: 1 }] });
  const sale = erp.sales.convertQuote(quote.id, { payments: [{ amount: 10000 }] });
  assert.equal(sale.gst_applied, 0);
  assert.equal(sale.total, 10000);
});

test('purchases take input credit only when the shop is registered for GST', () => {
  const supplier = erp.master.saveSupplier({ name: 'Local supplier' });
  const po = erp.purchasing.savePurchase({ supplierId: supplier.id, lines: [{ productId: item.id, qty: 4, unitCost: 5000 }] });
  erp.purchasing.markOrdered(po.id);
  assert.equal(erp.purchasing.receivePurchase(po.id).tax_total, 3600);

  erp.settings.save({ gst_registered: false });
  const po2 = erp.purchasing.savePurchase({ supplierId: supplier.id, lines: [{ productId: item.id, qty: 4, unitCost: 5000 }] });
  erp.purchasing.markOrdered(po2.id);
  const unregistered = erp.purchasing.receivePurchase(po2.id);
  assert.equal(unregistered.tax_total, 0);
  assert.equal(unregistered.total, 20000);
});

test('the GST return counts only tax invoices, and the plain bills are left out', () => {
  const range = { from: '2000-01-01', to: '2100-12-31' };
  erp.sales.createSale({ gst: true, lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  erp.sales.createSale({ gst: false, lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 10000 }] });
  const gst = erp.reports.gstReturn(range);
  assert.equal(gst.outward.taxable, 10000);
  assert.equal(gst.b2c.invoices, 1);
  assert.equal(gst.hsn.reduce((n, r) => n + r.qty, 0), 1);
});

test('bills of supply still appear in the sales reports', () => {
  erp.sales.createSale({ gst: false, lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 10000 }] });
  assert.equal(erp.reports.salesSummary({}).reduce((n, r) => n + r.invoices, 0), 1);
});
