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

test('GST billing is on by default', () => {
  const fresh = createERP();
  assert.equal(fresh.settings.get('gst_billing'), true);
  fresh.close();
});

test('with GST billing off, a sale carries no tax even if the product has a rate', () => {
  erp.settings.save({ gst_billing: false });
  const sale = erp.sales.createSale({ lines: [{ productId: item.id, qty: 2 }], payments: [{ amount: 20000 }] });
  assert.equal(sale.gst_applied, 0);
  assert.equal(sale.tax_total, 0);
  assert.equal(sale.cgst_total + sale.sgst_total + sale.igst_total, 0);
  assert.equal(sale.total, 20000, 'the customer pays the price, with no GST added');
  assert.equal(sale.lines[0].tax_rate, 0);
});

test('a client that still sends a tax rate cannot add GST when billing is off', () => {
  erp.settings.save({ gst_billing: false });
  const sale = erp.sales.createSale({ lines: [{ productId: item.id, qty: 1, taxRate: 18 }], payments: [{ amount: 10000 }] });
  assert.equal(sale.tax_total, 0);
});

test('a sale made with GST on keeps its tax after billing is switched off', () => {
  const taxed = erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  erp.settings.save({ gst_billing: false });
  assert.equal(erp.sales.getSale(taxed.id).gst_applied, 1);
  assert.equal(erp.sales.getSale(taxed.id).tax_total, 1800);
});

test('a return on a plain bill gives back the plain amount with no tax', () => {
  erp.settings.save({ gst_billing: false });
  const sale = erp.sales.createSale({ lines: [{ productId: item.id, qty: 2 }], payments: [{ amount: 20000 }] });
  const back = erp.sales.createReturn({
    invoiceId: sale.id, lines: [{ productId: item.id, qty: 1 }], refunds: [{ amount: 10000 }],
  });
  assert.equal(back.gst_applied, 0);
  assert.equal(back.total, 10000);
  assert.equal(erp.inventory.totalStock(item.id), 49);
});

test('a return on a GST invoice still reverses the GST, even after billing is switched off', () => {
  const taxed = erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  erp.settings.save({ gst_billing: false });
  const back = erp.sales.createReturn({
    invoiceId: taxed.id, lines: [{ productId: item.id, qty: 1 }], refunds: [{ amount: 11800 }],
  });
  assert.equal(back.gst_applied, 1);
  assert.equal(back.tax_total, 1800);
});

test('purchases record no input credit when billing is off', () => {
  erp.settings.save({ gst_billing: false });
  const supplier = erp.master.saveSupplier({ name: 'Local supplier' });
  const po = erp.purchasing.savePurchase({ supplierId: supplier.id, lines: [{ productId: item.id, qty: 4, unitCost: 5000 }] });
  erp.purchasing.markOrdered(po.id);
  const received = erp.purchasing.receivePurchase(po.id);
  assert.equal(received.tax_total, 0);
  assert.equal(received.total, 20000);
});

test('plain bills are left out of the GST return figures', () => {
  const range = { from: '2000-01-01', to: '2100-12-31' };
  erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 11800 }] });
  erp.settings.save({ gst_billing: false });
  erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 10000 }] });

  const gst = erp.reports.gstReturn(range);
  assert.equal(gst.outward.taxable, 10000, 'only the GST bill counts');
  assert.equal(gst.b2c.invoices, 1);
  assert.equal(gst.hsn.reduce((n, r) => n + r.qty, 0), 1);
});

test('plain bills still appear in the sales reports', () => {
  erp.settings.save({ gst_billing: false });
  erp.sales.createSale({ lines: [{ productId: item.id, qty: 1 }], payments: [{ amount: 10000 }] });
  const summary = erp.reports.salesSummary({});
  assert.equal(summary.reduce((n, r) => n + r.invoices, 0), 1);
});
