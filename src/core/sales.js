'use strict';

const { ensure, localDate, nowIso, text, cents, qtyOf, rate, sum } = require('./util');
const { customerBalance } = require('./ledger');

const DOC_PREFIX = { invoice: 'INV', return: 'RET', quote: 'QTE' };
const money = (cents) => (cents / 100).toFixed(2);

// Sales invoices (point of sale and credit), returns against invoices, and quotes.
// Totals are computed here, never trusted from the client.
function createSales({ db, repo, tx, nextNumber, inventory }) {
  function requireProduct(id) {
    const product = repo.find('products', id);
    ensure(product, 'Product not found', 404);
    return product;
  }

  function requireCustomer(id) {
    const customer = repo.find('customers', id);
    ensure(customer, 'Customer not found', 404);
    return customer;
  }

  function resolveWarehouse(id) {
    const warehouse = id
      ? repo.find('warehouses', id)
      : db.prepare('SELECT * FROM warehouses WHERE deleted = 0 ORDER BY rowid LIMIT 1').get();
    ensure(warehouse, 'Warehouse not found', 404);
    return warehouse.id;
  }

  // Price one line. Anything the caller omits comes from the product.
  function priceLine(product, input) {
    const qty = qtyOf(input.qty);
    ensure(qty > 0, `Quantity for ${product.name} must be greater than zero`);
    const unitPrice = cents(input.unitPrice ?? product.price, 'Unit price');
    ensure(unitPrice >= 0, 'Unit price cannot be negative');
    const discount = Number(input.discountPct ?? 0);
    ensure(discount >= 0 && discount <= 100, 'Discount must be between 0 and 100%');
    const taxRate = rate(input.taxRate ?? product.tax_rate);
    const net = Math.round(qty * unitPrice * (1 - discount / 100));
    const taxAmount = Math.round((net * taxRate) / 100);
    return {
      product_id: product.id,
      description: product.name,
      qty,
      unit_price: unitPrice,
      discount_pct: discount,
      unit_cost: input.unitCost ?? product.cost,
      tax_rate: taxRate,
      net,
      tax_amount: taxAmount,
      total: net + taxAmount,
    };
  }

  function totalsOf(lines) {
    return lines.reduce(
      (t, l) => ({ subtotal: t.subtotal + l.net, tax_total: t.tax_total + l.tax_amount, total: t.total + l.total }),
      { subtotal: 0, tax_total: 0, total: 0 },
    );
  }

  function normalizePayments(list = []) {
    return list
      .map((p) => ({ method: text(p.method) || 'cash', amount: cents(p.amount, 'Payment amount') }))
      .map((p) => {
        ensure(p.amount >= 0, 'Payment amount cannot be negative');
        return p;
      })
      .filter((p) => p.amount > 0);
  }

  function buildLines(inputs) {
    ensure(Array.isArray(inputs) && inputs.length, 'Add at least one item');
    return inputs.map((input) => priceLine(requireProduct(input.productId), input));
  }

  function assertCredit(customer, due) {
    ensure(customer.credit_limit > 0, `${customer.name} is not approved for credit sales`);
    const balance = customerBalance(db, customer.id);
    ensure(
      balance + due <= customer.credit_limit,
      `Credit limit exceeded for ${customer.name}: limit ${money(customer.credit_limit)}, balance ${money(balance)}`,
    );
  }

  function saveDocument({ type, status, date, customer, warehouseId, refDocId = null, lines, totals, payments, note, by }) {
    const doc = repo.save('sales_docs', {
      number: nextNumber(DOC_PREFIX[type]),
      type,
      status,
      date,
      customer_id: customer ? customer.id : null,
      warehouse_id: warehouseId,
      ref_doc_id: refDocId,
      subtotal: totals.subtotal,
      tax_total: totals.tax_total,
      total: totals.total,
      payment_method: payments.map((p) => p.method).join(', ') || null,
      note: text(note),
      created_by: by || 'system',
      created_at: nowIso(),
    });
    for (const line of lines) repo.save('sales_lines', { ...line, doc_id: doc.id });
    return doc;
  }

  function recordPayments({ docId, customer, payments, date, by, kind }) {
    for (const payment of payments) {
      repo.save('payments', {
        number: nextNumber(kind === 'refund' ? 'RFD' : 'RCT'),
        kind,
        party_type: customer ? 'customer' : null,
        party_id: customer ? customer.id : null,
        doc_id: docId,
        amount: payment.amount,
        method: payment.method,
        date,
        created_by: by || 'system',
        created_at: nowIso(),
      });
    }
  }

  function createSale(input = {}) {
    return tx(() => {
      const customer = input.customerId ? requireCustomer(input.customerId) : null;
      const warehouseId = resolveWarehouse(input.warehouseId);
      const date = input.date || localDate();
      const lines = buildLines(input.lines);
      const totals = totalsOf(lines);
      const payments = normalizePayments(input.payments);
      const paid = sum(payments.map((p) => p.amount));
      ensure(paid <= totals.total, 'Payments are more than the total');
      const due = totals.total - paid;
      if (due > 0) {
        ensure(customer, 'Select a customer for a credit sale, or take full payment');
        assertCredit(customer, due);
      }

      const doc = saveDocument({
        type: 'invoice', status: 'posted', date, customer, warehouseId, lines, totals, payments,
        note: input.note, by: input.by,
      });
      for (const line of lines) {
        inventory.postMovement({
          productId: line.product_id, warehouseId, qty: -line.qty, type: 'sale',
          refId: doc.id, unitCost: line.unit_cost, date, note: doc.number,
        });
      }
      recordPayments({ docId: doc.id, customer, payments, date, by: input.by, kind: 'receipt' });
      return getSale(doc.id);
    });
  }

  function createReturn({ invoiceId, lines: inputs, refunds = [], date, note, by }) {
    return tx(() => {
      const invoice = repo.find('sales_docs', invoiceId);
      ensure(invoice && invoice.type === 'invoice' && invoice.status === 'posted', 'Invoice not found', 404);
      ensure(Array.isArray(inputs) && inputs.length, 'Select items to return');

      const originals = db.prepare('SELECT * FROM sales_lines WHERE doc_id = ? AND deleted = 0 ORDER BY rowid').all(invoice.id);
      const alreadyReturned = (productId) => db.prepare(
        `SELECT COALESCE(SUM(l.qty), 0) AS n FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
          WHERE d.ref_doc_id = ? AND d.type = 'return' AND d.deleted = 0 AND l.deleted = 0 AND l.product_id = ?`,
      ).get(invoice.id, productId).n;

      const lines = inputs.map((input) => {
        const matching = originals.filter((l) => l.product_id === input.productId);
        ensure(matching.length, 'That product is not on this invoice');
        const sold = sum(matching.map((l) => l.qty));
        const available = sold - alreadyReturned(input.productId);
        const qty = qtyOf(input.qty, 'Return quantity');
        ensure(qty > 0 && qty <= available + 1e-9, `Only ${available} can still be returned for ${matching[0].description}`);
        const original = matching[0];
        return priceLine({ id: original.product_id, name: original.description }, {
          qty,
          unitPrice: original.unit_price,
          discountPct: original.discount_pct,
          taxRate: original.tax_rate,
          unitCost: original.unit_cost,
        });
      });

      const day = date || localDate();
      const totals = totalsOf(lines);
      const refund = normalizePayments(refunds);
      const refunded = sum(refund.map((r) => r.amount));
      ensure(refunded <= totals.total, 'Refund is more than the return total');
      const customer = invoice.customer_id ? repo.find('customers', invoice.customer_id) : null;
      if (!customer) ensure(refunded === totals.total, 'Walk-in returns must be refunded in full');

      const doc = saveDocument({
        type: 'return', status: 'posted', date: day, customer, warehouseId: invoice.warehouse_id,
        refDocId: invoice.id, lines, totals, payments: refund, note, by,
      });
      for (const line of lines) {
        inventory.postMovement({
          productId: line.product_id, warehouseId: invoice.warehouse_id, qty: line.qty, type: 'return',
          refId: doc.id, unitCost: line.unit_cost, date: day, note: doc.number,
        });
      }
      recordPayments({ docId: doc.id, customer, payments: refund, date: day, by, kind: 'refund' });
      return getSale(doc.id);
    });
  }

  function createQuote(input = {}) {
    return tx(() => {
      const customer = input.customerId ? requireCustomer(input.customerId) : null;
      const lines = buildLines(input.lines);
      const doc = saveDocument({
        type: 'quote', status: 'open', date: input.date || localDate(), customer,
        warehouseId: resolveWarehouse(input.warehouseId), lines, totals: totalsOf(lines), payments: [],
        note: input.note, by: input.by,
      });
      return getSale(doc.id);
    });
  }

  function convertQuote(quoteId, input = {}) {
    return tx(() => {
      const quote = repo.find('sales_docs', quoteId);
      ensure(quote && quote.type === 'quote' && quote.status === 'open', 'Quote is not open', 404);
      const quoteLines = db.prepare('SELECT * FROM sales_lines WHERE doc_id = ? AND deleted = 0 ORDER BY rowid').all(quote.id);
      const sale = createSale({
        ...input,
        customerId: input.customerId ?? quote.customer_id,
        warehouseId: input.warehouseId ?? quote.warehouse_id,
        lines: input.lines || quoteLines.map((l) => ({
          productId: l.product_id, qty: l.qty, unitPrice: l.unit_price, discountPct: l.discount_pct, taxRate: l.tax_rate,
        })),
      });
      repo.save('sales_docs', { id: quote.id, status: 'converted', ref_doc_id: sale.id });
      return sale;
    });
  }

  function cancelQuote(id) {
    const quote = repo.find('sales_docs', id);
    ensure(quote && quote.type === 'quote' && quote.status === 'open', 'Only open quotes can be cancelled', 404);
    return repo.save('sales_docs', { id, status: 'cancelled' });
  }

  function listSales({ type = 'invoice', customerId, from = '0000-01-01', to = '9999-12-31', q = '', limit = 300 } = {}) {
    const params = [type, from, to];
    let where = 'd.type = ? AND d.date BETWEEN ? AND ?';
    if (customerId) { where += ' AND d.customer_id = ?'; params.push(customerId); }
    if (q) { where += ' AND (d.number LIKE ? OR c.name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    return db.prepare(
      `SELECT d.*, c.name AS customer_name,
              COALESCE((SELECT SUM(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                          FROM payments p WHERE p.doc_id = d.id AND p.deleted = 0), 0) AS settled
         FROM sales_docs d LEFT JOIN customers c ON c.id = d.customer_id
        WHERE d.deleted = 0 AND ${where}
        ORDER BY d.date DESC, d.created_at DESC LIMIT ${Number(limit)}`,
    ).all(...params);
  }

  function getSale(id) {
    const doc = repo.find('sales_docs', id);
    ensure(doc, 'Sale not found', 404);
    const customer = doc.customer_id ? repo.find('customers', doc.customer_id) : null;
    const warehouse = repo.find('warehouses', doc.warehouse_id);
    const lines = db.prepare('SELECT * FROM sales_lines WHERE doc_id = ? AND deleted = 0 ORDER BY rowid').all(id);
    const payments = db.prepare('SELECT * FROM payments WHERE doc_id = ? AND deleted = 0 ORDER BY rowid').all(id);
    const returns = db.prepare(
      "SELECT id, number, date, total FROM sales_docs WHERE ref_doc_id = ? AND type = 'return' AND deleted = 0 ORDER BY date",
    ).all(id);
    const settled = sum(payments.map((p) => (p.kind === 'refund' ? -p.amount : p.amount)));
    const due = doc.type === 'invoice' ? doc.total - sum(returns.map((r) => r.total)) - settled : 0;
    return {
      ...doc,
      customer,
      customer_name: customer ? customer.name : null,
      warehouse,
      lines,
      payments,
      returns,
      settled,
      due,
    };
  }

  return { createSale, createReturn, createQuote, convertQuote, cancelQuote, listSales, getSale };
}

module.exports = { createSales };
