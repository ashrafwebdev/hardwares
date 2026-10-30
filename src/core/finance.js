'use strict';

const { ensure, localDate, nowIso, text, cents } = require('./util');
const { customerBalance, supplierBalance } = require('./ledger');

// Money in and out that is not tied to a sale: customer receipts, refunds of
// credit, supplier payments and operating expenses.
function createFinance({ db, repo, tx, nextNumber }) {
  const positive = (value, field) => {
    const amount = cents(value, field);
    ensure(amount > 0, `${field} must be greater than zero`);
    return amount;
  };

  function receiveFromCustomer({ customerId, amount, method, docId, date, note, by }) {
    return tx(() => {
      const customer = repo.find('customers', customerId);
      ensure(customer, 'Customer not found', 404);
      const value = positive(amount, 'Amount');
      const balance = customerBalance(db, customer.id);
      ensure(value <= balance, `Amount is more than the balance due (${(balance / 100).toFixed(2)})`);
      if (docId) {
        const doc = repo.find('sales_docs', docId);
        ensure(doc && doc.customer_id === customer.id, 'Invoice does not belong to this customer', 400);
      }
      return repo.save('payments', {
        number: nextNumber('RCT'), kind: 'receipt', party_type: 'customer', party_id: customer.id,
        doc_id: docId || null, amount: value, method: text(method) || 'cash',
        date: date || localDate(), note: text(note), created_by: by || 'system', created_at: nowIso(),
      });
    });
  }

  // Refund money owed to a customer, from a credit balance built up by returns.
  function refundCustomer({ customerId, amount, method, date, note, by }) {
    return tx(() => {
      const customer = repo.find('customers', customerId);
      ensure(customer, 'Customer not found', 404);
      const value = positive(amount, 'Amount');
      const credit = -customerBalance(db, customer.id);
      ensure(value <= credit, `Refund is more than the customer's credit (${(Math.max(credit, 0) / 100).toFixed(2)})`);
      return repo.save('payments', {
        number: nextNumber('RFD'), kind: 'refund', party_type: 'customer', party_id: customer.id,
        doc_id: null, amount: value, method: text(method) || 'cash',
        date: date || localDate(), note: text(note), created_by: by || 'system', created_at: nowIso(),
      });
    });
  }

  function paySupplier({ supplierId, amount, method, date, note, by }) {
    return tx(() => {
      const supplier = repo.find('suppliers', supplierId);
      ensure(supplier, 'Supplier not found', 404);
      const value = positive(amount, 'Amount');
      const balance = supplierBalance(db, supplier.id);
      ensure(value <= balance, `Payment is more than the amount owed (${(balance / 100).toFixed(2)})`);
      return repo.save('payments', {
        number: nextNumber('PMT'), kind: 'payment', party_type: 'supplier', party_id: supplier.id,
        doc_id: null, amount: value, method: text(method) || 'cash',
        date: date || localDate(), note: text(note), created_by: by || 'system', created_at: nowIso(),
      });
    });
  }

  function listPayments({ partyType, partyId, from = '0000-01-01', to = '9999-12-31', limit = 300 } = {}) {
    const where = ['p.date BETWEEN ? AND ?'];
    const params = [from, to];
    if (partyType) { where.push('p.party_type = ?'); params.push(partyType); }
    if (partyId) { where.push('p.party_id = ?'); params.push(partyId); }
    return db.prepare(
      `SELECT p.*, COALESCE(c.name, s.name) AS party_name
         FROM payments p
         LEFT JOIN customers c ON c.id = p.party_id
         LEFT JOIN suppliers s ON s.id = p.party_id
        WHERE p.deleted = 0 AND ${where.join(' AND ')}
        ORDER BY p.date DESC, p.created_at DESC LIMIT ${Number(limit)}`,
    ).all(...params);
  }

  function addExpense({ date, category, description, amount, method, by }) {
    const name = text(category);
    ensure(name, 'Expense category is required');
    return repo.save('expenses', {
      date: date || localDate(), category: name, description: text(description),
      amount: positive(amount, 'Amount'), method: text(method) || 'cash',
      created_by: by || 'system', created_at: nowIso(),
    });
  }

  function listExpenses({ from = '0000-01-01', to = '9999-12-31', limit = 300 } = {}) {
    return repo.list('expenses', {
      where: 'date BETWEEN ? AND ?', params: [from, to], orderBy: 'date DESC, created_at DESC', limit,
    });
  }

  function removeExpense(id) {
    ensure(repo.find('expenses', id), 'Expense not found', 404);
    return repo.remove('expenses', id);
  }

  return { receiveFromCustomer, refundCustomer, paySupplier, listPayments, addExpense, listExpenses, removeExpense };
}

module.exports = { createFinance };
