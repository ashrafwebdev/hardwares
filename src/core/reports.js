'use strict';

const { ensure, localDate, sum } = require('./util');
const { customerBalance, supplierBalance, customerAging } = require('./ledger');

// Read-only figures. Returns are subtracted by sign rather than stored negative.
function createReports({ db, repo, inventory, sales }) {
  const sign = (alias) => `(CASE WHEN ${alias}.type = 'invoice' THEN 1 ELSE -1 END)`;
  const POSTED_SALES = "d.deleted = 0 AND d.status = 'posted' AND d.type IN ('invoice', 'return') AND d.date BETWEEN ? AND ?";

  function netSales(from, to) {
    return db.prepare(`SELECT COALESCE(SUM(${sign('d')} * d.total), 0) AS n FROM sales_docs d WHERE ${POSTED_SALES}`)
      .get(from, to).n;
  }

  function salesSummary({ from = '0000-01-01', to = '9999-12-31', groupBy = 'day' } = {}) {
    const period = groupBy === 'month' ? 'substr(d.date, 1, 7)' : 'd.date';
    return db.prepare(
      `SELECT ${period} AS period,
              SUM(CASE WHEN d.type = 'invoice' THEN 1 ELSE 0 END) AS invoices,
              SUM(CASE WHEN d.type = 'return' THEN 1 ELSE 0 END) AS returns,
              SUM(${sign('d')} * d.subtotal) AS net_sales,
              SUM(${sign('d')} * d.tax_total) AS tax,
              SUM(${sign('d')} * d.total) AS gross_sales
         FROM sales_docs d WHERE ${POSTED_SALES}
        GROUP BY period ORDER BY period`,
    ).all(from, to);
  }

  function topProducts({ from = '0000-01-01', to = '9999-12-31', limit = 20 } = {}) {
    const rows = db.prepare(
      `SELECT l.product_id, MAX(l.description) AS name, p.sku,
              SUM(${sign('d')} * l.qty) AS qty,
              SUM(${sign('d')} * l.net) AS revenue,
              SUM(${sign('d')} * ROUND(l.qty * l.unit_cost)) AS cost
         FROM sales_lines l
         JOIN sales_docs d ON d.id = l.doc_id
         LEFT JOIN products p ON p.id = l.product_id
        WHERE l.deleted = 0 AND ${POSTED_SALES}
        GROUP BY l.product_id ORDER BY revenue DESC LIMIT ${Number(limit)}`,
    ).all(from, to);
    return rows.map((r) => ({ ...r, cost: Math.round(r.cost), gross_profit: Math.round(r.revenue - r.cost) }));
  }

  function profitAndLoss({ from = '0000-01-01', to = '9999-12-31' } = {}) {
    const totals = db.prepare(
      `SELECT COALESCE(SUM(${sign('d')} * l.net), 0) AS revenue,
              COALESCE(SUM(${sign('d')} * ROUND(l.qty * l.unit_cost)), 0) AS cogs,
              COALESCE(SUM(${sign('d')} * l.tax_amount), 0) AS tax
         FROM sales_lines l JOIN sales_docs d ON d.id = l.doc_id
        WHERE l.deleted = 0 AND ${POSTED_SALES}`,
    ).get(from, to);
    const expenses = db.prepare(
      'SELECT category, SUM(amount) AS amount FROM expenses WHERE deleted = 0 AND date BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC',
    ).all(from, to);
    const revenue = Math.round(totals.revenue);
    const cogs = Math.round(totals.cogs);
    const totalExpenses = sum(expenses.map((e) => e.amount));
    const grossProfit = revenue - cogs;
    return {
      from,
      to,
      revenue,
      tax: Math.round(totals.tax),
      cogs,
      gross_profit: grossProfit,
      gross_margin: revenue ? Math.round((grossProfit / revenue) * 1000) / 10 : 0,
      expenses,
      total_expenses: totalExpenses,
      net_profit: grossProfit - totalExpenses,
    };
  }

  function stockValuation() {
    const items = db.prepare(
      `SELECT p.id, p.sku, p.name, p.unit, p.cost,
              COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.product_id = p.id AND m.deleted = 0), 0) AS qty
         FROM products p WHERE p.deleted = 0 AND p.active = 1 ORDER BY p.name`,
    ).all().map((p) => ({ ...p, value: Math.round(p.qty * p.cost) }));
    return { items, total: sum(items.map((i) => i.value)) };
  }

  function receivables() {
    return repo.list('customers', { orderBy: 'name' })
      .map((c) => ({ id: c.id, name: c.name, balance: customerBalance(db, c.id), aging: customerAging(db, c.id) }))
      .filter((r) => r.balance !== 0);
  }

  function payables() {
    return repo.list('suppliers', { orderBy: 'name' })
      .map((s) => ({ id: s.id, name: s.name, phone: s.phone, balance: supplierBalance(db, s.id) }))
      .filter((r) => r.balance !== 0);
  }

  function dashboard() {
    const today = localDate();
    const monthStart = `${today.slice(0, 8)}01`;
    const receivableTotal = repo.list('customers').reduce((s, c) => s + Math.max(customerBalance(db, c.id), 0), 0);
    const payableTotal = repo.list('suppliers').reduce((s, c) => s + Math.max(supplierBalance(db, c.id), 0), 0);
    return {
      today,
      sales_today: netSales(today, today),
      sales_month: netSales(monthStart, today),
      invoices_today: db.prepare(
        "SELECT COUNT(*) AS n FROM sales_docs WHERE deleted = 0 AND status = 'posted' AND type = 'invoice' AND date = ?",
      ).get(today).n,
      low_stock_count: inventory.lowStockItems().length,
      receivables: receivableTotal,
      payables: payableTotal,
      top_products: topProducts({ from: monthStart, to: today, limit: 5 }),
      recent_sales: sales.listSales({ limit: 8 }),
    };
  }

  function customerStatement(id) {
    const customer = repo.find('customers', id);
    ensure(customer, 'Customer not found', 404);
    return {
      customer: { ...customer, balance: customerBalance(db, id) },
      aging: customerAging(db, id),
      invoices: sales.listSales({ type: 'invoice', customerId: id, limit: 200 }),
      returns: sales.listSales({ type: 'return', customerId: id, limit: 200 }),
      payments: db.prepare(
        "SELECT * FROM payments WHERE party_type = 'customer' AND party_id = ? AND deleted = 0 ORDER BY date DESC, created_at DESC LIMIT 200",
      ).all(id),
    };
  }

  function supplierStatement(id) {
    const supplier = repo.find('suppliers', id);
    ensure(supplier, 'Supplier not found', 404);
    return {
      supplier: { ...supplier, balance: supplierBalance(db, id) },
      purchases: db.prepare(
        "SELECT * FROM purchase_docs WHERE supplier_id = ? AND status = 'received' AND deleted = 0 ORDER BY date DESC LIMIT 200",
      ).all(id),
      payments: db.prepare(
        "SELECT * FROM payments WHERE party_type = 'supplier' AND party_id = ? AND deleted = 0 ORDER BY date DESC, created_at DESC LIMIT 200",
      ).all(id),
    };
  }

  // GST figures in the layout of GSTR-1 (sales) and GSTR-3B (summary). These are the
  // numbers to file from, not a filed return: check them with your CA before filing.
  function gstReturn({ from = '0000-01-01', to = '9999-12-31' } = {}) {
    const outward = db.prepare(
      `SELECT COALESCE(SUM(${sign('d')} * d.subtotal), 0) AS taxable,
              COALESCE(SUM(${sign('d')} * d.cgst_total), 0) AS cgst,
              COALESCE(SUM(${sign('d')} * d.sgst_total), 0) AS sgst,
              COALESCE(SUM(${sign('d')} * d.igst_total), 0) AS igst
         FROM sales_docs d WHERE ${POSTED_SALES}`,
    ).get(from, to);
    const inward = db.prepare(
      `SELECT COALESCE(SUM(subtotal), 0) AS taxable, COALESCE(SUM(cgst_total), 0) AS cgst,
              COALESCE(SUM(sgst_total), 0) AS sgst, COALESCE(SUM(igst_total), 0) AS igst
         FROM purchase_docs
        WHERE deleted = 0 AND status = 'received' AND received_date BETWEEN ? AND ?`,
    ).get(from, to);

    const hsn = db.prepare(
      `SELECT COALESCE(l.hsn_code, '') AS hsn_code, MAX(p.unit) AS unit, l.tax_rate,
              SUM(${sign('d')} * l.qty) AS qty,
              SUM(${sign('d')} * l.net) AS taxable,
              SUM(${sign('d')} * l.cgst) AS cgst,
              SUM(${sign('d')} * l.sgst) AS sgst,
              SUM(${sign('d')} * l.igst) AS igst,
              SUM(${sign('d')} * l.tax_amount) AS tax
         FROM sales_lines l
         JOIN sales_docs d ON d.id = l.doc_id
         LEFT JOIN products p ON p.id = l.product_id
        WHERE l.deleted = 0 AND ${POSTED_SALES}
        GROUP BY COALESCE(l.hsn_code, ''), l.tax_rate ORDER BY COALESCE(l.hsn_code, ''), l.tax_rate`,
    ).all(from, to);

    const documentsWithGstin = (type) => db.prepare(
      `SELECT d.number, d.date, d.customer_gstin, c.name AS customer_name, d.place_of_supply,
              d.is_interstate, ${sign('d')} * d.subtotal AS taxable, ${sign('d')} * d.tax_total AS tax,
              ${sign('d')} * d.total AS total
         FROM sales_docs d LEFT JOIN customers c ON c.id = d.customer_id
        WHERE d.deleted = 0 AND d.status = 'posted' AND d.type = ? AND d.customer_gstin IS NOT NULL
          AND d.date BETWEEN ? AND ?
        ORDER BY d.date, d.number`,
    ).all(type, from, to);

    const b2c = db.prepare(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(subtotal), 0) AS taxable,
              COALESCE(SUM(tax_total), 0) AS tax, COALESCE(SUM(total), 0) AS total
         FROM sales_docs
        WHERE deleted = 0 AND status = 'posted' AND type = 'invoice' AND customer_gstin IS NULL
          AND date BETWEEN ? AND ?`,
    ).get(from, to);

    const outwardTax = Math.round(outward.cgst + outward.sgst + outward.igst);
    const inputTax = Math.round(inward.cgst + inward.sgst + inward.igst);
    return {
      from,
      to,
      outward: {
        taxable: Math.round(outward.taxable), cgst: Math.round(outward.cgst),
        sgst: Math.round(outward.sgst), igst: Math.round(outward.igst), tax: outwardTax,
      },
      input_tax_credit: {
        taxable: Math.round(inward.taxable), cgst: Math.round(inward.cgst),
        sgst: Math.round(inward.sgst), igst: Math.round(inward.igst), tax: inputTax,
      },
      net_payable: outwardTax - inputTax,
      hsn: hsn.map((r) => ({
        ...r, hsn_code: r.hsn_code || 'Not set', taxable: Math.round(r.taxable), cgst: Math.round(r.cgst),
        sgst: Math.round(r.sgst), igst: Math.round(r.igst), tax: Math.round(r.tax),
      })),
      b2b_invoices: documentsWithGstin('invoice'),
      b2b_credit_notes: documentsWithGstin('return'),
      b2c: { invoices: b2c.invoices, taxable: b2c.taxable, tax: b2c.tax, total: b2c.total },
    };
  }

  return {
    gstReturn, salesSummary, topProducts, profitAndLoss, stockValuation, receivables, payables, dashboard, netSales,
    customerStatement, supplierStatement,
  };
}

module.exports = { createReports };
