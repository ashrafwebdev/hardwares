'use strict';

const { localDate } = require('./util');

// Balances are always derived from documents and payments, never stored,
// so they cannot drift out of step with the transactions behind them.

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params).n;
}

// Positive = customer owes the shop. Negative = shop owes the customer (credit).
function customerBalance(db, customerId) {
  const customer = db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(customerId);
  if (!customer) return 0;
  const invoices = one(db, "SELECT COALESCE(SUM(total), 0) AS n FROM sales_docs WHERE customer_id = ? AND type = 'invoice' AND status = 'posted' AND deleted = 0", customerId);
  const returns = one(db, "SELECT COALESCE(SUM(total), 0) AS n FROM sales_docs WHERE customer_id = ? AND type = 'return' AND status = 'posted' AND deleted = 0", customerId);
  const receipts = one(db, "SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE party_type = 'customer' AND party_id = ? AND kind = 'receipt' AND deleted = 0", customerId);
  const refunds = one(db, "SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE party_type = 'customer' AND party_id = ? AND kind = 'refund' AND deleted = 0", customerId);
  return customer.opening_balance + invoices - returns - receipts + refunds;
}

// Positive = shop owes the supplier.
function supplierBalance(db, supplierId) {
  const supplier = db.prepare('SELECT opening_balance FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) return 0;
  const bills = one(db, "SELECT COALESCE(SUM(total), 0) AS n FROM purchase_docs WHERE supplier_id = ? AND status = 'received' AND deleted = 0", supplierId);
  const paid = one(db, "SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE party_type = 'supplier' AND party_id = ? AND kind = 'payment' AND deleted = 0", supplierId);
  return supplier.opening_balance + bills - paid;
}

// Match credits (returns, receipts, refunds) against the oldest debits first,
// then bucket what is still open by age. This is the usual FIFO approach.
function customerAging(db, customerId, today = localDate()) {
  const customer = db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(customerId);
  const debits = [
    { date: '0000-01-01', amount: customer ? customer.opening_balance : 0 },
    ...db.prepare("SELECT date, total AS amount FROM sales_docs WHERE customer_id = ? AND type = 'invoice' AND status = 'posted' AND deleted = 0 ORDER BY date, created_at")
      .all(customerId),
  ].filter((d) => d.amount > 0);

  const credits = customerBalance(db, customerId) - debits.reduce((s, d) => s + d.amount, 0);
  let remaining = -credits;
  const buckets = { current: 0, days31to60: 0, days61to90: 0, over90: 0 };
  for (const debit of debits) {
    const used = Math.min(Math.max(remaining, 0), debit.amount);
    remaining -= used;
    const open = debit.amount - used;
    if (open <= 0) continue;
    const days = Math.floor((Date.parse(today) - Date.parse(debit.date)) / 86400000);
    if (days <= 30) buckets.current += open;
    else if (days <= 60) buckets.days31to60 += open;
    else if (days <= 90) buckets.days61to90 += open;
    else buckets.over90 += open;
  }
  return buckets;
}

module.exports = { customerBalance, supplierBalance, customerAging };
