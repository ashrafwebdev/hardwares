/* Hardware ERP web client. Plain JavaScript, no build step.
 * Routes are hash-based (#/sell, #/product/<id>?q=...), so every screen is bookmarkable. */
(() => {
  'use strict';

  const ALL = ['admin', 'manager', 'cashier'];
  const MANAGE = ['admin', 'manager'];
  const ADMIN = ['admin'];
  const PAYMENT_METHODS = ['cash', 'card', 'bank transfer', 'mobile money', 'cheque'];
  const EXPENSE_CATEGORIES = ['Rent', 'Utilities', 'Salaries', 'Transport', 'Repairs', 'Marketing', 'Office', 'Other'];

  const NAV = [
    { id: 'dashboard', label: 'Dashboard', roles: ALL },
    { id: 'sell', label: 'Point of sale', roles: ALL },
    { id: 'sales', label: 'Sales & credit notes', roles: ALL },
    { id: 'quotes', label: 'Quotes', roles: ALL },
    { id: 'customers', label: 'Customers', roles: ALL },
    { id: 'products', label: 'Products', roles: ALL },
    { id: 'inventory', label: 'Inventory', roles: MANAGE },
    { id: 'suppliers', label: 'Suppliers', roles: MANAGE },
    { id: 'purchases', label: 'Purchases', roles: MANAGE },
    { id: 'expenses', label: 'Expenses', roles: MANAGE },
    { id: 'reports', label: 'Reports', roles: MANAGE },
    { id: 'settings', label: 'Settings', roles: ADMIN },
  ];

  const state = {
    token: safeGet('erp_token') || '',
    user: null,
    status: null,
    settings: {},
    warehouses: [],
    categories: [],
    customers: [],
    pos: newCart(),
    products: new Map(),
    po: { lines: [] },
    sale: null,
    report: null,
    meta: { states: [], gstRates: [] },
  };

  const app = document.getElementById('app');
  const $ = (selector, root = document) => root.querySelector(selector);
  const isManager = () => MANAGE.includes(state.user?.role);
  const isAdmin = () => state.user?.role === 'admin';

  // ---- helpers --------------------------------------------------------------

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable: keep the session in memory */ }
  }
  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Indian grouping, for example 1,23,45,678.00
  const inr = (cents) => (Number(cents || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (cents) => `${state.settings.currency || '₹'}${inr(cents)}`;
  const amount = (cents) => (Number(cents || 0) / 100).toFixed(2);
  const num = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
  const toCents = (value) => Math.round(parseFloat(value || 0) * 100) || 0;
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const monthStart = () => `${today().slice(0, 8)}01`;
  const isoDate = (value) => String(value || '').slice(0, 10);
  // Display as dd-mm-yyyy, the usual Indian format.
  const dateOnly = (value) => {
    const [y, m, d] = isoDate(value).split('-');
    return d ? `${d}-${m}-${y}` : '';
  };
  const stateName = (code) => state.meta.states.find((x) => x.code === code)?.name || '—';
  const stateOptions = (selected) => options(
    state.meta.states.map((x) => ({ id: x.code, name: `${x.code} · ${x.name}` })), selected, (x) => x.name, 'Select state',
  );
  const gstOptions = (selected) => {
    const current = Number(selected ?? 0);
    const rates = [...new Set([...state.meta.gstRates, current])].sort((a, b) => a - b);
    return rates.map((r) => `<option value="${r}" ${r === current ? 'selected' : ''}>${r}%</option>`).join('');
  };
  const options = (items, selected, label = (i) => i.name, blank = '') => [
    blank !== null ? `<option value="">${esc(blank)}</option>` : '',
    ...items.map((i) => `<option value="${esc(i.id)}" ${i.id === selected ? 'selected' : ''}>${esc(label(i))}</option>`),
  ].join('');
  const statusBadge = (status) => {
    const tone = { posted: 'ok', received: 'ok', converted: 'ok', paid: 'ok', open: 'warn', ordered: 'warn', draft: '', cancelled: 'bad' }[status] || '';
    return `<span class="badge ${tone}">${esc(status)}</span>`;
  };
  const kpi = (label, value, warn = false) => `<div class="kpi ${warn ? 'warn' : ''}"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`;

  function table(columns, rows, { rowLink, empty = 'Nothing here yet.' } = {}) {
    if (!rows.length) return `<div class="table-wrap"><div class="empty">${esc(empty)}</div></div>`;
    const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
    const body = rows.map((row) => {
      const href = rowLink ? rowLink(row) : null;
      const cells = columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render(row)}</td>`).join('');
      return `<tr ${href ? `class="clickable" data-href="${esc(href)}"` : ''}>${cells}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function toCsv(headers, rows) {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\n');
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let toastTimer = null;
  function toast(message, kind = 'ok') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3000);
  }

  // Read a form into a plain object. data-kind: money (major units -> cents),
  // num (number), opt (empty -> null). Checkboxes become booleans.
  function readForm(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') { out[el.name] = el.checked; continue; }
      const kind = el.dataset.kind;
      const raw = el.value;
      if (kind === 'money') out[el.name] = toCents(raw);
      else if (kind === 'num') out[el.name] = raw === '' ? 0 : Number(raw);
      else if (kind === 'opt') out[el.name] = raw === '' ? null : raw;
      else out[el.name] = raw;
    }
    return out;
  }

  // ---- API ----------------------------------------------------------------------

  async function api(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(`/api${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && state.user) {
      signedOut();
      throw new Error('Your session has ended. Please sign in again.');
    }
    if (!response.ok) {
      let message = `Request failed (HTTP ${response.status})`;
      try { message = (await response.json()).error || message; } catch { /* keep default */ }
      throw new Error(message);
    }
    return response.json();
  }

  async function downloadFile(path, fallbackName) {
    const response = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${state.token}` } });
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
    const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '');
    download(match ? match[1] : fallbackName, await response.blob(), 'application/octet-stream');
  }

  async function loadShared() {
    const [settings, warehouses, categories, meta] = await Promise.all([
      api('GET', '/settings'), api('GET', '/warehouses'), api('GET', '/categories'), api('GET', '/meta'),
    ]);
    state.settings = settings;
    state.meta = meta;
    state.warehouses = warehouses;
    state.categories = categories;
  }

  function signedOut() {
    state.token = '';
    state.user = null;
    safeRemove('erp_token');
    render();
  }

  // ---- routing and shell ----------------------------------------------------------

  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [pathPart, queryPart = ''] = hash.split('?');
    const [page, ...args] = pathPart.split('/').map(decodeURIComponent);
    return { page: page || 'dashboard', args, query: new URLSearchParams(queryPart) };
  }

  function go(path, params) {
    const qs = params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString()}` : '';
    goTo(`#/${path}${qs}`);
  }

  // Setting the same hash fires no hashchange, so re-render explicitly in that case.
  function goTo(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function shell(content, page) {
    const links = NAV.filter((n) => n.roles.includes(state.user.role))
      .map((n) => `<a href="#/${n.id}" class="${n.id === page ? 'active' : ''}">${esc(n.label)}</a>`).join('');
    return `<div class="layout">
      <aside class="sidebar">
        <div class="brand">${esc(state.settings.company_name || 'Hardware ERP')}</div>
        <nav>${links}</nav>
        <div class="who">
          <div>${esc(state.user.name)} · ${esc(state.user.role)}</div>
          <div class="muted">Terminal ${esc(state.status?.terminal || '')}</div>
          <button type="button" class="link" data-action="logout">Sign out</button>
        </div>
      </aside>
      <main>${content}</main>
    </div>`;
  }

  async function render() {
    if (!state.user) return renderLogin();
    const { page, args, query } = route();
    const handler = PAGES[page];
    const nav = NAV.find((n) => n.id === page);
    if (!handler || (nav && !nav.roles.includes(state.user.role))) return go('dashboard');
    try {
      const view = await handler(args, query);
      app.innerHTML = shell(view.html, page);
      if (view.after) view.after();
    } catch (err) {
      app.innerHTML = shell(`<div class="panel"><h2>Something went wrong</h2><p>${esc(err.message)}</p>
        <a class="btn" href="#/dashboard">Back to dashboard</a></div>`, page);
    }
  }

  function renderLogin() {
    app.innerHTML = `<div class="auth"><div class="panel">
      <h1>${esc(state.status?.company || 'Hardware ERP')}</h1>
      <form data-submit="login">
        <label>Username <input name="username" autocomplete="username" required autofocus></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">Sign in</button>
      </form></div></div>`;
  }

  function renderSetup() {
    app.innerHTML = `<div class="auth"><div class="panel">
      <h1>Set up your shop</h1>
      <p class="muted">Create the administrator account. You can add cashiers and managers afterwards.</p>
      <form data-submit="setup">
        <label>Shop name <input name="company_name" required value="My Hardware Shop"></label>
        <label>Admin username <input name="username" required autocomplete="username"></label>
        <label>Full name <input name="name"></label>
        <label>Password (min 6 characters) <input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
        <button class="primary" type="submit">Create shop</button>
      </form></div></div>`;
  }

  // ---- point of sale -------------------------------------------------------------------

  function newCart() {
    return { customerId: '', lines: [], tender: '', method: 'cash', quoteId: null, note: '' };
  }

  // Mirrors src/core/sales.js. The server recalculates everything when the sale is saved.
  function lineTotals(line) {
    const amount = Math.round(line.qty * line.unitPrice * (1 - line.discountPct / 100));
    if (state.settings.prices_include_gst) {
      const net = Math.round((amount * 100) / (100 + line.taxRate));
      return { net, tax: amount - net, total: amount };
    }
    const tax = Math.round((amount * line.taxRate) / 100);
    return { net: amount, tax, total: amount + tax };
  }

  function cartTotals(cart) {
    const raw = cart.lines.reduce((t, line) => {
      const l = lineTotals(line);
      return { subtotal: t.subtotal + l.net, tax: t.tax + l.tax, total: t.total + l.total };
    }, { subtotal: 0, tax: 0, total: 0 });
    if (!state.settings.round_invoice_totals) return { ...raw, roundOff: 0 };
    const total = Math.round(raw.total / 100) * 100;
    return { ...raw, total, roundOff: total - raw.total };
  }

  function addToCart(product) {
    const cart = state.pos;
    const existing = cart.lines.find((l) => l.productId === product.id);
    if (existing) existing.qty = Math.round((existing.qty + 1) * 1000) / 1000;
    else {
      cart.lines.push({
        productId: product.id, name: product.name, sku: product.sku, unit: product.unit,
        stock: product.stock, qty: 1, unitPrice: product.price, discountPct: 0, taxRate: product.tax_rate,
      });
    }
    renderPosCart();
  }

  async function searchPos(term) {
    const results = $('#pos-results');
    if (!results) return;
    const q = term.trim();
    if (!q) { results.innerHTML = ''; return; }
    const products = await api('GET', `/products?q=${encodeURIComponent(q)}`);
    state.products = new Map(products.map((p) => [p.id, p]));
    results.innerHTML = products.slice(0, 20).map((p) => `
      <button type="button" data-action="pos-add" data-id="${esc(p.id)}">
        <strong>${esc(p.name)}</strong><span class="num">${money(p.price)}</span>
        <small>${esc(p.sku)} · ${num(p.stock)} ${esc(p.unit)} in stock</small>
      </button>`).join('') || '<div class="empty">No products match.</div>';
  }

  function renderPosCart() {
    const cart = state.pos;
    const el = $('#pos-cart');
    if (!el) return;
    const rows = cart.lines.map((line, i) => `<tr>
        <td><strong>${esc(line.name)}</strong><div class="muted">${esc(line.sku || '')}${line.stock !== undefined ? ` · stock ${num(line.stock)}` : ''}</div></td>
        <td class="num"><input class="qty" type="number" min="0" step="0.001" value="${line.qty}" data-on="pos-line" data-field="qty" data-idx="${i}" aria-label="Quantity"></td>
        <td class="num"><input class="money" type="number" min="0" step="0.01" value="${amount(line.unitPrice)}" data-on="pos-line" data-field="unitPrice" data-idx="${i}" aria-label="Unit price"></td>
        <td class="num"><input class="qty" type="number" min="0" max="100" step="0.5" value="${line.discountPct}" data-on="pos-line" data-field="discountPct" data-idx="${i}" aria-label="Discount %"></td>
        <td class="num">${money(lineTotals(line).total)}</td>
        <td><button type="button" data-action="pos-line-remove" data-idx="${i}" aria-label="Remove">✕</button></td>
      </tr>`).join('');
    el.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <label style="flex:1">Customer
          <select data-on="pos-customer">${options(state.customers, cart.customerId, (c) => `${c.name}${c.balance > 0 ? ` (owes ${money(c.balance)})` : ''}`, 'Walk-in customer')}</select>
        </label>
        <label>Warehouse
          <select data-on="pos-warehouse">${options(state.warehouses, state.pos.warehouseId || state.warehouses[0]?.id, (w) => w.name, null)}</select>
        </label>
      </div>
      ${cart.lines.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Disc %</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<div class="empty">Scan a barcode or search for items to start a sale.</div>'}
      <div id="pos-totals" style="margin-top:16px"></div>
      <div class="row" style="margin-top:12px">
        <label>Payment
          <select data-on="pos-method">${PAYMENT_METHODS.map((m) => `<option ${m === cart.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
        </label>
        <label>Amount received
          <input class="money" type="number" min="0" step="0.01" value="${esc(cart.tender)}" data-on="pos-tender" placeholder="0.00" aria-label="Amount received">
        </label>
      </div>
      <div class="row" style="margin-top:16px">
        <button type="button" class="primary" data-action="pos-complete" ${cart.lines.length ? '' : 'disabled'}>Complete sale</button>
        <button type="button" data-action="pos-quote" ${cart.lines.length ? '' : 'disabled'}>Save as quote</button>
        <button type="button" class="danger" data-action="pos-clear">Clear</button>
      </div>`;
    updatePosTotals();
  }

  function updatePosTotals() {
    const el = $('#pos-totals');
    if (!el) return;
    const cart = state.pos;
    const t = cartTotals(cart);
    const received = toCents(cart.tender);
    const change = Math.max(received - t.total, 0);
    const due = Math.max(t.total - received, 0);
    el.innerHTML = `<div class="totals">
      <span>Subtotal</span><span class="num">${money(t.subtotal)}</span>
      <span>GST</span><span class="num">${money(t.tax)}</span>
      ${t.roundOff ? `<span>Round off</span><span class="num">${money(t.roundOff)}</span>` : ''}
      <span class="grand">Total</span><span class="num grand">${money(t.total)}</span>
      ${received > 0 ? `<span>Received</span><span class="num">${money(received)}</span>` : ''}
      ${change > 0 ? `<span><strong>Change due</strong></span><span class="num"><strong>${money(change)}</strong></span>` : ''}
      ${due > 0 && cart.customerId ? `<span>Left on account</span><span class="num">${money(due)}</span>` : ''}
      ${due > 0 && !cart.customerId && received > 0 ? '<span></span><span class="muted">Select a customer to sell on credit</span>' : ''}
    </div>`;
  }

  function posPayload() {
    const cart = state.pos;
    const t = cartTotals(cart);
    const paid = Math.min(toCents(cart.tender), t.total);
    return {
      customerId: cart.customerId || null,
      warehouseId: cart.warehouseId || state.warehouses[0]?.id,
      lines: cart.lines.map((l) => ({
        productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate,
      })),
      payments: paid > 0 ? [{ method: cart.method, amount: paid }] : [],
      note: cart.note,
    };
  }

  async function loadQuoteIntoPos(id) {
    const quote = await api('GET', `/sales/${id}`);
    state.pos = {
      ...newCart(),
      customerId: quote.customer_id || '',
      quoteId: quote.id,
      warehouseId: quote.warehouse_id,
      lines: quote.lines.map((l) => ({
        productId: l.product_id, name: l.description, sku: '', unit: '', qty: l.qty,
        unitPrice: l.unit_price, discountPct: l.discount_pct, taxRate: l.tax_rate,
      })),
    };
    go('sell');
  }

  // ---- pages -------------------------------------------------------------------------

  const PAGES = {};

  PAGES.dashboard = async () => {
    const d = await api('GET', '/dashboard');
    return {
      html: `<div class="toolbar"><h1>Dashboard</h1><a class="btn primary" href="#/sell">New sale</a></div>
        <div class="grid">
          ${kpi('Sales today', money(d.sales_today))}
          ${kpi('Sales this month', money(d.sales_month))}
          ${kpi('Invoices today', d.invoices_today)}
          ${kpi('Low-stock items', d.low_stock_count, d.low_stock_count > 0)}
          ${kpi('Owed by customers', money(d.receivables))}
          ${kpi('Owed to suppliers', money(d.payables))}
        </div>
        <div class="two" style="margin-top:16px">
          <section><h2>Top products this month</h2>${table([
            { label: 'Product', render: (r) => esc(r.name) },
            { label: 'Qty', num: true, render: (r) => num(r.qty) },
            { label: 'Revenue', num: true, render: (r) => money(r.revenue) },
          ], d.top_products, { empty: 'No sales this month yet.' })}</section>
          <section><h2>Recent sales</h2>${table([
            { label: 'Number', render: (r) => esc(r.number) },
            { label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
            { label: 'Total', num: true, render: (r) => money(r.total) },
          ], d.recent_sales, { rowLink: (r) => `#/sale/${r.id}`, empty: 'No sales yet.' })}</section>
        </div>`,
    };
  };

  PAGES.sell = async () => {
    state.customers = await api('GET', '/customers');
    if (!state.pos.warehouseId) state.pos.warehouseId = state.warehouses[0]?.id;
    return {
      html: `<div class="toolbar"><h1>Point of sale${state.pos.quoteId ? ' <span class="badge">from quote</span>' : ''}</h1></div>
        <div class="pos">
          <section>
            <div class="panel">
              <label>Find item
                <input id="pos-search" type="search" autofocus placeholder="Scan barcode, or type SKU or name" data-on="pos-search" data-enter="pos-scan" autocomplete="off">
              </label>
            </div>
            <div id="pos-results" class="results"></div>
          </section>
          <section class="panel" id="pos-cart"></section>
        </div>`,
      after: renderPosCart,
    };
  };

  PAGES.sales = async (args, query) => {
    const filters = { q: query.get('q') || '', from: query.get('from') || '', to: query.get('to') || '' };
    const [invoices, returns] = await Promise.all([
      api('GET', `/sales?${new URLSearchParams(filters)}`),
      api('GET', `/returns?${new URLSearchParams(filters)}`),
    ]);
    return {
      html: `<div class="toolbar"><h1>Sales & credit notes</h1><a class="btn primary" href="#/sell">New sale</a></div>
        ${filterForm('sales', filters, [['q', 'Search number or customer'], ['from', 'From', 'date'], ['to', 'To', 'date']])}
        <h2>Invoices</h2>
        ${table([
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
          { label: 'Total', num: true, render: (r) => money(r.total) },
          { label: 'Paid', num: true, render: (r) => money(r.settled) },
          { label: 'Status', render: (r) => statusBadge(r.status) },
        ], invoices, { rowLink: (r) => `#/sale/${r.id}`, empty: 'No invoices match.' })}
        <h2 style="margin-top:24px">Credit notes</h2>
        ${table([
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
          { label: 'Total', num: true, render: (r) => money(r.total) },
          { label: 'Refunded', num: true, render: (r) => money(-r.settled) },
        ], returns, { rowLink: (r) => `#/sale/${r.id}`, empty: 'No returns match.' })}`,
    };
  };

  PAGES.quotes = async () => {
    const quotes = await api('GET', '/quotes');
    return {
      html: `<div class="toolbar"><h1>Quotes</h1><a class="btn primary" href="#/sell">New quote from sale screen</a></div>
        ${table([
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Customer', render: (r) => esc(r.customer_name || 'Walk-in') },
          { label: 'Total', num: true, render: (r) => money(r.total) },
          { label: 'Status', render: (r) => statusBadge(r.status) },
        ], quotes, { rowLink: (r) => `#/sale/${r.id}`, empty: 'No quotes yet. Use "Save as quote" on the sale screen.' })}`,
    };
  };

  PAGES.sale = async ([id]) => {
    const s = await api('GET', `/sales/${id}`);
    state.sale = s;
    const isInvoice = s.type === 'invoice';
    const isOpenQuote = s.type === 'quote' && s.status === 'open';
    const heading = { invoice: 'Tax invoice', return: 'Credit note', quote: 'Quotation' }[s.type];
    const showReturnForm = isInvoice && s.status === 'posted' && s.lines.length > 0;
    const gstRows = s.is_interstate
      ? [['IGST', s.igst_total]]
      : [['CGST', s.cgst_total], ['SGST', s.sgst_total]];
    return {
      html: `<div class="toolbar no-print">
          <a href="#/${s.type === 'quote' ? 'quotes' : 'sales'}">← Back</a>
          <div class="row">
            ${isOpenQuote ? `<button type="button" class="primary" data-action="quote-convert" data-id="${esc(s.id)}">Convert to sale</button>` : ''}
            ${isOpenQuote ? `<button type="button" class="danger" data-action="quote-cancel" data-id="${esc(s.id)}">Cancel quote</button>` : ''}
            <button type="button" data-action="print">Print</button>
          </div>
        </div>
        <article class="panel receipt">
          <div class="head">
            <h1>${esc(s.seller?.name || state.settings.company_name)}</h1>
            <div class="muted">${esc(state.settings.company_address || '')}${state.settings.company_phone ? ` · ${esc(state.settings.company_phone)}` : ''}</div>
            ${s.seller?.gstin ? `<div class="muted">GSTIN ${esc(s.seller.gstin)} · ${esc(stateName(s.seller.state_code))}</div>` : ''}
            <h2 style="margin-top:12px">${esc(heading)} ${esc(s.number)} ${statusBadge(s.status)}</h2>
          </div>
          <div class="meta">
            <div><strong>Bill to:</strong> ${esc(s.customer_name || 'Walk-in customer')}
              ${s.customer?.address ? `<br>${esc(s.customer.address)}` : ''}
              ${s.customer_gstin ? `<br>GSTIN ${esc(s.customer_gstin)}` : ''}</div>
            <div><strong>Date:</strong> ${esc(dateOnly(s.date))}<br>
              <strong>Place of supply:</strong> ${esc(stateName(s.place_of_supply || s.seller?.state_code))}</div>
          </div>
          ${table([
            { label: 'Item', render: (r) => esc(r.description) },
            { label: 'HSN', render: (r) => esc(r.hsn_code || '—') },
            { label: 'Qty', num: true, render: (r) => num(r.qty) },
            { label: 'Rate', num: true, render: (r) => money(r.unit_price) },
            { label: 'Disc %', num: true, render: (r) => num(r.discount_pct) },
            { label: 'Taxable', num: true, render: (r) => money(r.net) },
            { label: 'GST %', num: true, render: (r) => num(r.tax_rate) },
            { label: 'GST', num: true, render: (r) => money(r.tax_amount) },
            { label: 'Amount', num: true, render: (r) => money(r.total) },
          ], s.lines, { empty: 'No lines' })}
          <div class="totals" style="margin:16px 0 0 auto;max-width:380px">
            <span>Taxable value</span><span class="num">${money(s.subtotal)}</span>
            ${gstRows.filter(([, v]) => v).map(([name, v]) => `<span>${name}</span><span class="num">${money(v)}</span>`).join('')}
            ${s.round_off ? `<span>Round off</span><span class="num">${money(s.round_off)}</span>` : ''}
            <span class="grand">${s.type === 'return' ? 'Credit amount' : 'Total'}</span><span class="num grand">${money(s.total)}</span>
            ${s.type !== 'quote' ? `<span>${s.type === 'return' ? 'Refunded' : 'Received'}</span><span class="num">${money(s.type === 'return' ? -s.settled : s.settled)}</span>` : ''}
            ${isInvoice && s.due > 0 ? `<span><strong>Balance due</strong></span><span class="num"><strong>${money(s.due)}</strong></span>` : ''}
          </div>
          <p style="margin-top:12px"><strong>Amount in words:</strong> ${esc(s.amount_in_words)}</p>
          ${s.payments.length ? `<h2 style="margin-top:16px">Payments</h2>${table([
            { label: 'Number', render: (r) => esc(r.number) },
            { label: 'Method', render: (r) => esc(r.method) },
            { label: 'Kind', render: (r) => esc(r.kind) },
            { label: 'Amount', num: true, render: (r) => money(r.amount) },
          ], s.payments)}` : ''}
          ${s.returns.length ? `<h2 style="margin-top:16px">Credit notes</h2>${table([
            { label: 'Number', render: (r) => esc(r.number) },
            { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
            { label: 'Total', num: true, render: (r) => money(r.total) },
          ], s.returns, { rowLink: (r) => `#/sale/${r.id}` })}` : ''}
          ${s.note ? `<p class="muted">Note: ${esc(s.note)}</p>` : ''}
          <div class="footer">${esc(state.settings.receipt_footer || '')}</div>
        </article>
        ${showReturnForm ? returnPanel(s) : ''}`,
    };
  };

  function returnPanel(sale) {
    const rows = sale.lines.map((l, i) => `<tr>
        <td>${esc(l.description)}</td>
        <td class="num">${num(l.qty)}</td>
        <td class="num"><input class="qty" type="number" min="0" max="${l.qty}" step="0.001" value="0"
            name="qty_${i}" data-kind="num" aria-label="Quantity to return for ${esc(l.description)}"></td>
      </tr>`).join('');
    return `<details class="panel no-print" open>
      <summary>Return items</summary>
      <form data-submit="sale-return" data-id="${esc(sale.id)}" class="stack">
        <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Return qty</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="row">
          <label>Refund method <select name="method">${PAYMENT_METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
          <label>Refund amount <input class="money" name="refund" type="number" min="0" step="0.01" data-kind="money" placeholder="${sale.customer_id ? '0.00 = credit to account' : 'Full refund'}"></label>
          <label style="flex:1">Note <input name="note"></label>
          <button class="primary" type="submit">Record return</button>
        </div>
      </form>
    </details>`;
  }

  PAGES.products = async (args, query) => {
    const filters = { q: query.get('q') || '', low: query.get('low') || '', cat: query.get('cat') || '', all: query.get('all') || '' };
    const params = new URLSearchParams({ q: filters.q, lowStock: filters.low === '1' ? '1' : '', all: filters.all === '1' ? '1' : '', categoryId: filters.cat });
    const products = await api('GET', `/products?${params}`);
    products.forEach((p) => state.products.set(p.id, p));
    return {
      html: `<div class="toolbar"><h1>Products</h1>
          ${isManager() ? '<a class="btn primary" href="#/product/new">New product</a>' : ''}</div>
        ${filterForm('products', filters, [['q', 'Search name, SKU, barcode, location'], ['cat', 'Category', 'select']], {
          extra: `<label class="inline"><input type="checkbox" name="low" value="1" ${filters.low === '1' ? 'checked' : ''}> Low stock only</label>
                  <label class="inline"><input type="checkbox" name="all" value="1" ${filters.all === '1' ? 'checked' : ''}> Include inactive</label>`,
          categories: state.categories,
        })}
        ${table([
          { label: 'SKU', render: (r) => esc(r.sku) },
          { label: 'Name', render: (r) => esc(r.name) + (r.active ? '' : ' <span class="badge">inactive</span>') },
          { label: 'Category', render: (r) => esc(r.category_name || '') },
          { label: 'Cost', num: true, render: (r) => money(r.cost) },
          { label: 'Price', num: true, render: (r) => money(r.price) },
          { label: 'GST %', num: true, render: (r) => num(r.tax_rate) },
          { label: 'Stock', num: true, render: (r) => `${num(r.stock)} ${esc(r.unit)}${r.reorder_level > 0 && r.stock <= r.reorder_level ? ' <span class="badge warn">low</span>' : ''}` },
        ], products, { rowLink: (r) => `#/product/${r.id}`, empty: 'No products match.' })}
        ${isManager() ? categoriesPanel() : ''}`,
    };
  };

  function categoriesPanel() {
    return `<details class="panel" style="margin-top:24px"><summary>Categories (${state.categories.length})</summary>
      <form data-submit="category-add" class="row" style="margin-bottom:12px">
        <label>New category <input name="name" required></label>
        <label>Parent <select name="parent_id">${options(state.categories, '', (c) => c.name)}</select></label>
        <button class="primary" type="submit">Add</button>
      </form>
      ${table([
        { label: 'Category', render: (r) => esc(r.name) },
        { label: '', render: (r) => `<button type="button" class="danger" data-action="category-delete" data-id="${esc(r.id)}">Delete</button>` },
      ], state.categories, { empty: 'No categories yet.' })}
    </details>`;
  }

  function filterForm(page, values, fields, { extra = '', categories = null } = {}) {
    const inputs = fields.map(([name, label, type]) => {
      if (type === 'select' && categories) {
        return `<label>${esc(label)}<select name="${name}">${options(categories, values[name], (c) => c.name, 'All')}</select></label>`;
      }
      return `<label>${esc(label)}<input name="${name}" type="${type || 'search'}" value="${esc(values[name] || '')}"></label>`;
    }).join('');
    return `<form class="panel row no-print" data-submit="filter" data-page="${esc(page)}">
      ${inputs}${extra}<button type="submit">Filter</button>
      <button type="button" data-action="filter-clear" data-page="${esc(page)}">Clear</button>
    </form>`;
  }

  PAGES.product = async ([id]) => {
    const editable = isManager();
    const product = id === 'new' ? { active: 1, unit: 'pcs', tax_rate: state.settings.default_tax_rate, reorder_level: 0 } : await api('GET', `/products/${id}`);
    const [suppliers, movements] = await Promise.all([
      isManager() ? api('GET', '/suppliers') : Promise.resolve([]),
      isManager() && id !== 'new' ? api('GET', `/inventory/movements?productId=${id}`) : Promise.resolve([]),
    ]);
    const dis = editable ? '' : 'disabled';
    return {
      html: `<div class="toolbar"><h1>${id === 'new' ? 'New product' : esc(product.name)}</h1><a href="#/products">← Products</a></div>
        <form class="panel" data-submit="product-save" data-id="${id === 'new' ? '' : esc(id)}">
          <div class="grid">
            <label>SKU <input name="sku" required value="${esc(product.sku || '')}" ${dis}></label>
            <label>Barcode <input name="barcode" value="${esc(product.barcode || '')}" ${dis}></label>
            <label>HSN code <input name="hsn_code" inputmode="numeric" value="${esc(product.hsn_code || '')}" placeholder="4, 6 or 8 digits" ${dis}></label>
            <label>Name <input name="name" required value="${esc(product.name || '')}" ${dis}></label>
            <label>Category <select name="category_id" ${dis}>${options(state.categories, product.category_id, (c) => c.name)}</select></label>
            <label>Supplier <select name="supplier_id" ${dis}>${options(suppliers, product.supplier_id, (s) => s.name)}</select></label>
            <label>Unit <input name="unit" value="${esc(product.unit || 'pcs')}" ${dis}></label>
            <label>Cost <input class="money" name="cost" data-kind="money" type="number" step="0.01" min="0" value="${amount(product.cost)}" ${dis}></label>
            <label>Selling price <input class="money" name="price" data-kind="money" type="number" step="0.01" min="0" value="${amount(product.price)}" ${dis}></label>
            <label>GST rate <select name="tax_rate" data-kind="num" ${dis}>${gstOptions(product.tax_rate ?? state.settings.default_tax_rate)}</select></label>
            <label>Reorder level <input name="reorder_level" data-kind="num" type="number" step="0.001" min="0" value="${product.reorder_level ?? 0}" ${dis}></label>
            <label>Shelf location <input name="location" value="${esc(product.location || '')}" ${dis}></label>
          </div>
          <label style="margin-top:12px">Description <textarea name="description" rows="2" ${dis}>${esc(product.description || '')}</textarea></label>
          <label class="inline" style="margin-top:12px"><input type="checkbox" name="active" ${product.active ? 'checked' : ''} ${dis}> Active (sold and shown in lists)</label>
          ${editable ? '<div style="margin-top:16px"><button class="primary" type="submit">Save product</button></div>' : '<p class="muted">Only managers can change products.</p>'}
        </form>
        ${id === 'new' ? '' : `<section class="panel"><h2>Stock by warehouse</h2>${table([
          { label: 'Warehouse', render: (r) => esc(r.name) },
          { label: 'On hand', num: true, render: (r) => `${num(r.qty)} ${esc(product.unit)}` },
        ], product.stockByWarehouse)}</section>
        <section class="panel"><h2>Recent stock movements</h2>${table([
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Type', render: (r) => esc(r.type.replace('_', ' ')) },
          { label: 'Warehouse', render: (r) => esc(r.warehouse_name || '') },
          { label: 'Qty', num: true, render: (r) => num(r.qty) },
          { label: 'Note', render: (r) => esc(r.note || '') },
        ], movements.slice(0, 50), { empty: 'No movements yet.' })}</section>`}`,
    };
  };

  PAGES.inventory = async (args, query) => {
    const filters = { wh: query.get('wh') || '', q: query.get('q') || '', low: query.get('low') || '' };
    const [levels, products, movements] = await Promise.all([
      api('GET', `/inventory/levels?${new URLSearchParams({ warehouseId: filters.wh, q: filters.q, lowOnly: filters.low === '1' ? '1' : '' })}`),
      api('GET', '/products'),
      api('GET', `/inventory/movements${filters.wh ? `?warehouseId=${encodeURIComponent(filters.wh)}` : ''}`),
    ]);
    return {
      html: `<div class="toolbar"><h1>Inventory</h1></div>
        <form class="panel row no-print" data-submit="filter" data-page="inventory">
          <label>Warehouse <select name="wh">${options(state.warehouses, filters.wh, (w) => w.name, 'All warehouses')}</select></label>
          <label>Search <input type="search" name="q" value="${esc(filters.q)}"></label>
          <label class="inline"><input type="checkbox" name="low" value="1" ${filters.low === '1' ? 'checked' : ''}> Low stock only</label>
          <button type="submit">Filter</button>
        </form>
        <div class="two">
          <section class="panel">
            <h2>Stock on hand</h2>
            ${table([
              { label: 'Product', render: (r) => `${esc(r.name)}<div class="muted">${esc(r.sku)} · ${esc(r.warehouse_name)}</div>` },
              { label: 'Qty', num: true, render: (r) => `${num(r.qty)} ${esc(r.unit)}${r.low ? ' <span class="badge warn">low</span>' : ''}` },
              { label: 'Count', render: (r) => `<form data-submit="stock-count" data-product="${esc(r.product_id)}" data-warehouse="${esc(r.warehouse_id)}" class="row" style="flex-wrap:nowrap">
                  <input class="qty" name="counted" type="number" step="0.001" min="0" value="${r.qty}" aria-label="Counted quantity">
                  <button type="submit">Save</button></form>` },
            ], levels, { empty: 'No products yet.' })}
          </section>
          <section class="panel">
            <h2>Transfer between warehouses</h2>
            <form data-submit="stock-transfer" class="stack">
              <label>Product <select name="productId" required>${options(products, '', (p) => `${p.name} (${p.sku})`, 'Choose product')}</select></label>
              <label>From <select name="fromWarehouseId" required>${options(state.warehouses, '', (w) => w.name, null)}</select></label>
              <label>To <select name="toWarehouseId" required>${options(state.warehouses, '', (w) => w.name, null)}</select></label>
              <label>Quantity <input name="qty" data-kind="num" type="number" step="0.001" min="0.001" required></label>
              <label>Note <input name="note"></label>
              <button class="primary" type="submit">Transfer stock</button>
            </form>
          </section>
        </div>
        <section class="panel" style="margin-top:16px"><h2>Recent movements</h2>${table([
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Product', render: (r) => esc(r.product_name) },
          { label: 'Warehouse', render: (r) => esc(r.warehouse_name || '') },
          { label: 'Type', render: (r) => esc(r.type.replace('_', ' ')) },
          { label: 'Qty', num: true, render: (r) => num(r.qty) },
          { label: 'Reference', render: (r) => esc(r.note || '') },
        ], movements.slice(0, 100), { empty: 'No movements yet.' })}</section>`,
    };
  };

  PAGES.customers = async (args, query) => {
    const q = query.get('q') || '';
    const customers = await api('GET', `/customers?q=${encodeURIComponent(q)}`);
    return {
      html: `<div class="toolbar"><h1>Customers</h1><a class="btn primary" href="#/customer/new">New customer</a></div>
        ${filterForm('customers', { q }, [['q', 'Search name, code or phone']])}
        ${table([
          { label: 'Name', render: (r) => esc(r.name) },
          { label: 'Phone', render: (r) => esc(r.phone || '') },
          { label: 'Credit limit', num: true, render: (r) => money(r.credit_limit) },
          { label: 'Balance', num: true, render: (r) => `<span class="${r.balance > 0 ? 'badge warn' : ''}">${money(r.balance)}</span>` },
        ], customers, { rowLink: (r) => `#/customer/${r.id}`, empty: 'No customers yet.' })}`,
    };
  };

  function partyForm(kind, record, { creditField = false } = {}) {
    const id = record.id || '';
    return `<form class="panel" data-submit="${kind}-save" data-id="${esc(id)}">
      <div class="grid">
        <label>Name <input name="name" required value="${esc(record.name || '')}"></label>
        <label>Code <input name="code" value="${esc(record.code || '')}"></label>
        <label>Phone <input name="phone" value="${esc(record.phone || '')}"></label>
        <label>Email <input name="email" type="email" value="${esc(record.email || '')}"></label>
        <label>Address <input name="address" value="${esc(record.address || '')}"></label>
        <label>GSTIN <input name="gstin" maxlength="15" value="${esc(record.gstin || '')}" placeholder="15 characters, optional"></label>
        <label>State <select name="state_code">${stateOptions(record.state_code)}</select></label>
        <label>PAN <input name="pan" maxlength="10" value="${esc(record.pan || '')}"></label>
        <label>Opening balance <input class="money" name="opening_balance" data-kind="money" type="number" step="0.01" value="${amount(record.opening_balance)}"></label>
        ${creditField ? `<label>Credit limit (0 = no credit) <input class="money" name="credit_limit" data-kind="money" type="number" step="0.01" min="0" value="${amount(record.credit_limit)}"></label>` : ''}
      </div>
      <label class="inline" style="margin-top:12px"><input type="checkbox" name="active" ${record.active === undefined || record.active ? 'checked' : ''}> Active</label>
      <div style="margin-top:12px"><button class="primary" type="submit">Save</button></div>
    </form>`;
  }

  PAGES.customer = async ([id]) => {
    if (id === 'new') {
      return { html: `<div class="toolbar"><h1>New customer</h1><a href="#/customers">← Customers</a></div>${partyForm('customer', {}, { creditField: true })}` };
    }
    const s = await api('GET', `/customers/${id}`);
    const c = s.customer;
    return {
      html: `<div class="toolbar"><h1>${esc(c.name)}</h1><a href="#/customers">← Customers</a></div>
        <div class="grid">
          ${kpi('Balance', money(c.balance), c.balance > 0)}
          ${kpi('Credit limit', money(c.credit_limit))}
          ${kpi('Current', money(s.aging.current))}
          ${kpi('31–60 days', money(s.aging.days31to60), s.aging.days31to60 > 0)}
          ${kpi('61–90 days', money(s.aging.days61to90), s.aging.days61to90 > 0)}
          ${kpi('Over 90 days', money(s.aging.over90), s.aging.over90 > 0)}
        </div>
        <div class="two" style="margin-top:16px">
          <section class="panel">
            <h2>Receive payment</h2>
            <form data-submit="customer-receive" data-id="${esc(c.id)}" class="stack">
              <label>Amount <input class="money" name="amount" data-kind="money" type="number" step="0.01" min="0.01" required></label>
              <label>Method <select name="method">${PAYMENT_METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
              <label>Against invoice (optional) <select name="docId">${options(s.invoices.filter((i) => i.total > i.settled), '', (i) => `${i.number} · due ${money(i.total - i.settled)}`, 'On account')}</select></label>
              <button class="primary" type="submit" ${c.balance > 0 ? '' : 'disabled'}>Record receipt</button>
            </form>
          </section>
          ${isManager() ? `<section class="panel">
            <h2>Refund credit</h2>
            <p class="muted">Credit available: ${money(Math.max(-c.balance, 0))}</p>
            <form data-submit="customer-refund" data-id="${esc(c.id)}" class="stack">
              <label>Amount <input class="money" name="amount" data-kind="money" type="number" step="0.01" min="0.01" required></label>
              <label>Method <select name="method">${PAYMENT_METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
              <button type="submit" ${c.balance < 0 ? '' : 'disabled'}>Refund</button>
            </form>
          </section>` : ''}
        </div>
        <details class="panel"><summary>Edit customer</summary>${partyForm('customer', c, { creditField: true })}</details>
        <h2>Invoices</h2>
        ${table([
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Total', num: true, render: (r) => money(r.total) },
          { label: 'Paid', num: true, render: (r) => money(r.settled) },
        ], s.invoices, { rowLink: (r) => `#/sale/${r.id}`, empty: 'No invoices yet.' })}
        <h2 style="margin-top:20px">Payments</h2>
        ${table([
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Kind', render: (r) => esc(r.kind) },
          { label: 'Method', render: (r) => esc(r.method) },
          { label: 'Amount', num: true, render: (r) => money(r.amount) },
        ], s.payments, { empty: 'No payments yet.' })}`,
    };
  };

  PAGES.suppliers = async (args, query) => {
    const q = query.get('q') || '';
    const suppliers = await api('GET', `/suppliers?q=${encodeURIComponent(q)}`);
    return {
      html: `<div class="toolbar"><h1>Suppliers</h1><a class="btn primary" href="#/supplier/new">New supplier</a></div>
        ${filterForm('suppliers', { q }, [['q', 'Search name, code or phone']])}
        ${table([
          { label: 'Name', render: (r) => esc(r.name) },
          { label: 'Phone', render: (r) => esc(r.phone || '') },
          { label: 'We owe', num: true, render: (r) => `<span class="${r.balance > 0 ? 'badge warn' : ''}">${money(r.balance)}</span>` },
        ], suppliers, { rowLink: (r) => `#/supplier/${r.id}`, empty: 'No suppliers yet.' })}`,
    };
  };

  PAGES.supplier = async ([id]) => {
    if (id === 'new') {
      return { html: `<div class="toolbar"><h1>New supplier</h1><a href="#/suppliers">← Suppliers</a></div>${partyForm('supplier', {})}` };
    }
    const s = await api('GET', `/suppliers/${id}`);
    const sup = s.supplier;
    return {
      html: `<div class="toolbar"><h1>${esc(sup.name)}</h1><a href="#/suppliers">← Suppliers</a></div>
        <div class="grid">${kpi('We owe', money(sup.balance), sup.balance > 0)}</div>
        <section class="panel" style="margin-top:16px">
          <h2>Pay supplier</h2>
          <form data-submit="supplier-pay" data-id="${esc(sup.id)}" class="row">
            <label>Amount <input class="money" name="amount" data-kind="money" type="number" step="0.01" min="0.01" required></label>
            <label>Method <select name="method">${PAYMENT_METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
            <label style="flex:1">Note <input name="note"></label>
            <button class="primary" type="submit" ${sup.balance > 0 ? '' : 'disabled'}>Record payment</button>
          </form>
        </section>
        <details class="panel"><summary>Edit supplier</summary>${partyForm('supplier', sup)}</details>
        <h2>Received purchases</h2>
        ${table([
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Received', render: (r) => esc(dateOnly(r.received_date || r.date)) },
          { label: 'Total', num: true, render: (r) => money(r.total) },
        ], s.purchases, { rowLink: (r) => `#/purchase/${r.id}`, empty: 'Nothing received yet.' })}
        <h2 style="margin-top:20px">Payments</h2>
        ${table([
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Method', render: (r) => esc(r.method) },
          { label: 'Amount', num: true, render: (r) => money(r.amount) },
        ], s.payments, { empty: 'No payments yet.' })}`,
    };
  };

  PAGES.purchases = async (args, query) => {
    const filters = { status: query.get('status') || '', q: query.get('q') || '' };
    const purchases = await api('GET', `/purchases?${new URLSearchParams(filters)}`);
    return {
      html: `<div class="toolbar"><h1>Purchase orders</h1><a class="btn primary" href="#/purchase/new">New purchase order</a></div>
        <form class="panel row no-print" data-submit="filter" data-page="purchases">
          <label>Status <select name="status">${options(
            ['draft', 'ordered', 'received', 'cancelled'].map((s) => ({ id: s, name: s })), filters.status, (s) => s.name, 'All',
          )}</select></label>
          <label>Search <input type="search" name="q" value="${esc(filters.q)}"></label>
          <button type="submit">Filter</button>
        </form>
        ${table([
          { label: 'Number', render: (r) => esc(r.number) },
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Supplier', render: (r) => esc(r.supplier_name || '') },
          { label: 'Total', num: true, render: (r) => money(r.total) },
          { label: 'Status', render: (r) => statusBadge(r.status) },
        ], purchases, { rowLink: (r) => `#/purchase/${r.id}`, empty: 'No purchase orders yet.' })}`,
    };
  };

  PAGES.purchase = async ([id]) => {
    const [products, suppliers] = await Promise.all([api('GET', '/products'), api('GET', '/suppliers')]);
    products.forEach((p) => state.products.set(p.id, p));
    if (id === 'new') {
      state.po = { lines: [] };
      return { html: poForm(null, products, suppliers), after: renderPoLines };
    }
    const order = await api('GET', `/purchases/${id}`);
    if (order.status === 'draft') {
      state.po = { lines: order.lines.map((l) => ({ productId: l.product_id, name: l.description, qty: l.qty, unitCost: l.unit_cost, taxRate: l.tax_rate })) };
      return { html: poForm(order, products, suppliers), after: renderPoLines };
    }
    const actions = {
      ordered: `<button type="button" class="primary" data-action="po-receive" data-id="${esc(order.id)}">Receive goods</button>
                <button type="button" class="danger" data-action="po-cancel" data-id="${esc(order.id)}">Cancel</button>`,
      received: '',
      cancelled: '',
    }[order.status] || '';
    return {
      html: `<div class="toolbar"><h1>${esc(order.number)} ${statusBadge(order.status)}</h1><div class="row">${actions}<a href="#/purchases">← Purchases</a></div></div>
        <section class="panel">
          <p><strong>Supplier:</strong> ${esc(order.supplier?.name || '')} · <strong>Warehouse:</strong> ${esc(order.warehouse?.name || '')}
          · <strong>Date:</strong> ${esc(dateOnly(order.date))}${order.received_date ? ` · <strong>Received:</strong> ${esc(dateOnly(order.received_date))}` : ''}</p>
          ${table([
            { label: 'Item', render: (r) => esc(r.description) },
            { label: 'Qty', num: true, render: (r) => num(r.qty) },
            { label: 'Unit cost', num: true, render: (r) => money(r.unit_cost) },
            { label: 'GST %', num: true, render: (r) => num(r.tax_rate) },
            { label: 'Total', num: true, render: (r) => money(r.total) },
          ], order.lines)}
          <div class="totals" style="margin:16px 0 0 auto;max-width:320px">
            <span>Subtotal</span><span class="num">${money(order.subtotal)}</span>
            <span>GST</span><span class="num">${money(order.tax_total)}</span>
            <span class="grand">Total</span><span class="num grand">${money(order.total)}</span>
          </div>
        </section>`,
    };
  };

  function poForm(order, products, suppliers) {
    const placeOrder = order
      ? `<button type="button" class="primary" data-action="po-order" data-id="${esc(order.id)}">Place order with supplier</button>`
      : '';
    return `<div class="toolbar"><h1>${order ? `Edit ${esc(order.number)}` : 'New purchase order'}</h1><div class="row">${placeOrder}<a href="#/purchases">← Purchases</a></div></div>
      <form class="panel stack" data-submit="po-save" data-id="${esc(order?.id || '')}">
        <div class="grid">
          <label>Supplier <select name="supplierId" required>${options(
            suppliers, order?.supplier_id || '', (s) => s.name, 'Choose supplier',
          )}</select></label>
          <label>Warehouse <select name="warehouseId">${options(state.warehouses, order?.warehouse_id || state.warehouses[0]?.id, (w) => w.name, null)}</select></label>
          <label>Date <input type="date" name="date" value="${esc(order ? isoDate(order.date) : today())}"></label>
          <label>Note <input name="note" value="${esc(order?.note || '')}"></label>
        </div>
        <div class="row">
          <label style="flex:1">Product <select id="po-product">${options(products, '', (p) => `${p.name} (${p.sku})`, 'Choose product')}</select></label>
          <label>Qty <input id="po-qty" class="qty" type="number" step="0.001" min="0.001" value="1"></label>
          <label>Unit cost <input id="po-cost" class="money" type="number" step="0.01" min="0"></label>
          <button type="button" data-action="po-line-add">Add line</button>
        </div>
        <div id="po-lines"></div>
        <div><button class="primary" type="submit">Save draft</button></div>
      </form>`;
  }

  function renderPoLines() {
    const el = $('#po-lines');
    if (!el) return;
    const productSelect = $('#po-product');
    if (productSelect) {
      productSelect.onchange = () => {
        const p = state.products.get(productSelect.value);
        if (p) $('#po-cost').value = amount(p.cost);
      };
    }
    const lines = state.po.lines;
    const total = lines.reduce((s, l) => {
      const net = Math.round(l.qty * l.unitCost);
      return s + net + Math.round((net * l.taxRate) / 100);
    }, 0);
    el.innerHTML = lines.length ? `<div class="table-wrap"><table><thead><tr>
        <th>Item</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th><th></th></tr></thead><tbody>
        ${lines.map((l, i) => `<tr><td>${esc(l.name)}</td><td class="num">${num(l.qty)}</td><td class="num">${money(l.unitCost)}</td>
          <td class="num">${money(Math.round(l.qty * l.unitCost * (1 + l.taxRate / 100)))}</td>
          <td><button type="button" data-action="po-line-remove" data-idx="${i}">✕</button></td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="3">Total incl. tax</td><td class="num">${money(total)}</td><td></td></tr></tfoot></table></div>`
      : '<div class="empty">Add the items you are ordering.</div>';
  }

  PAGES.expenses = async (args, query) => {
    const filters = { from: query.get('from') || monthStart(), to: query.get('to') || today() };
    const expenses = await api('GET', `/expenses?${new URLSearchParams(filters)}`);
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    return {
      html: `<div class="toolbar"><h1>Expenses</h1><div class="muted">Total ${money(total)}</div></div>
        <form class="panel row no-print" data-submit="filter" data-page="expenses">
          <label>From <input type="date" name="from" value="${esc(filters.from)}"></label>
          <label>To <input type="date" name="to" value="${esc(filters.to)}"></label>
          <button type="submit">Show</button>
        </form>
        <form class="panel" data-submit="expense-add">
          <h2>Record an expense</h2>
          <div class="grid">
            <label>Date <input type="date" name="date" value="${today()}"></label>
            <label>Category <input name="category" list="expense-categories" required><datalist id="expense-categories">${EXPENSE_CATEGORIES.map((c) => `<option value="${c}">`).join('')}</datalist></label>
            <label>Description <input name="description"></label>
            <label>Amount <input class="money" name="amount" data-kind="money" type="number" step="0.01" min="0.01" required></label>
            <label>Paid by <select name="method">${PAYMENT_METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
          </div>
          <div style="margin-top:12px"><button class="primary" type="submit">Save expense</button></div>
        </form>
        ${table([
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Category', render: (r) => esc(r.category) },
          { label: 'Description', render: (r) => esc(r.description || '') },
          { label: 'Paid by', render: (r) => esc(r.method) },
          { label: 'Amount', num: true, render: (r) => money(r.amount) },
          { label: '', render: (r) => `<button type="button" class="danger" data-action="expense-delete" data-id="${esc(r.id)}">Delete</button>` },
        ], expenses, { empty: 'No expenses in this period.' })}`,
    };
  };

  PAGES.reports = async (args, query) => {
    const type = query.get('type') || 'profit';
    const filters = { from: query.get('from') || monthStart(), to: query.get('to') || today(), type };
    const range = new URLSearchParams({ from: filters.from, to: filters.to });
    const tabs = [['profit', 'Profit & loss'], ['sales', 'Sales by day'], ['gst', 'GST returns'], ['top', 'Top products'], ['valuation', 'Stock valuation'], ['receivables', 'Receivables'], ['payables', 'Payables']];
    let body = '';
    let csv = null;

    if (type === 'profit') {
      const p = await api('GET', `/reports/profit?${range}`);
      body = `<div class="grid">
          ${kpi('Revenue (ex tax)', money(p.revenue))}${kpi('Cost of goods', money(p.cogs))}
          ${kpi('Gross profit', money(p.gross_profit))}${kpi('Gross margin', `${p.gross_margin}%`)}
          ${kpi('Expenses', money(p.total_expenses))}${kpi('Net profit', money(p.net_profit), p.net_profit < 0)}
        </div>
        <h2 style="margin-top:16px">Expenses by category</h2>
        ${table([{ label: 'Category', render: (r) => esc(r.category) }, { label: 'Amount', num: true, render: (r) => money(r.amount) }], p.expenses, { empty: 'No expenses in this period.' })}`;
      csv = { headers: ['Measure', 'Amount'], rows: [['Revenue', amount(p.revenue)], ['Cost of goods', amount(p.cogs)], ['Gross profit', amount(p.gross_profit)], ['Expenses', amount(p.total_expenses)], ['Net profit', amount(p.net_profit)]] };
    } else if (type === 'sales') {
      const rows = await api('GET', `/reports/sales?${range}&groupBy=day`);
      body = table([
        { label: 'Day', render: (r) => esc(r.period) },
        { label: 'Invoices', num: true, render: (r) => num(r.invoices) },
        { label: 'Returns', num: true, render: (r) => num(r.returns) },
        { label: 'Net sales', num: true, render: (r) => money(r.net_sales) },
        { label: 'Tax', num: true, render: (r) => money(r.tax) },
        { label: 'Gross sales', num: true, render: (r) => money(r.gross_sales) },
      ], rows, { empty: 'No sales in this period.' });
      csv = { headers: ['Day', 'Invoices', 'Returns', 'Net', 'Tax', 'Gross'], rows: rows.map((r) => [r.period, r.invoices, r.returns, amount(r.net_sales), amount(r.tax), amount(r.gross_sales)]) };
    } else if (type === 'top') {
      const rows = await api('GET', `/reports/top-products?${range}`);
      body = table([
        { label: 'Product', render: (r) => esc(r.name) },
        { label: 'Qty', num: true, render: (r) => num(r.qty) },
        { label: 'Revenue', num: true, render: (r) => money(r.revenue) },
        { label: 'Cost', num: true, render: (r) => money(r.cost) },
        { label: 'Gross profit', num: true, render: (r) => money(r.gross_profit) },
      ], rows, { empty: 'No sales in this period.' });
      csv = { headers: ['Product', 'SKU', 'Qty', 'Revenue', 'Cost', 'Gross profit'], rows: rows.map((r) => [r.name, r.sku, r.qty, amount(r.revenue), amount(r.cost), amount(r.gross_profit)]) };
    } else if (type === 'gst') {
      const g = await api('GET', `/reports/gst?${range}`);
      const gstRow = (label, o) => `<tr><td>${label}</td><td class="num">${money(o.taxable)}</td>
        <td class="num">${money(o.cgst)}</td><td class="num">${money(o.sgst)}</td><td class="num">${money(o.igst)}</td>
        <td class="num">${money(o.tax)}</td></tr>`;
      body = `<div class="grid">
          ${kpi('Output GST on sales', money(g.outward.tax))}
          ${kpi('Input tax credit on purchases', money(g.input_tax_credit.tax))}
          ${kpi('Net GST payable', money(g.net_payable), g.net_payable > 0)}
        </div>
        <h2 style="margin-top:16px">Summary (GSTR-3B style)</h2>
        <div class="table-wrap"><table><thead><tr><th>Supplies</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Total GST</th></tr></thead>
          <tbody>${gstRow('Outward supplies (sales less credit notes)', g.outward)}${gstRow('Inward supplies (purchases)', g.input_tax_credit)}</tbody></table></div>
        <p class="muted">Net payable is output GST less input tax credit. A negative figure carries forward to the next month.</p>
        <h2 style="margin-top:20px">HSN-wise summary</h2>
        ${table([
          { label: 'HSN', render: (r) => esc(r.hsn_code) },
          { label: 'Unit', render: (r) => esc(r.unit || '') },
          { label: 'Qty', num: true, render: (r) => num(r.qty) },
          { label: 'GST %', num: true, render: (r) => num(r.tax_rate) },
          { label: 'Taxable', num: true, render: (r) => money(r.taxable) },
          { label: 'CGST', num: true, render: (r) => money(r.cgst) },
          { label: 'SGST', num: true, render: (r) => money(r.sgst) },
          { label: 'IGST', num: true, render: (r) => money(r.igst) },
        ], g.hsn, { empty: 'No sales in this period.' })}
        <h2 style="margin-top:20px">B2B invoices (customers with GSTIN)</h2>
        ${table([
          { label: 'Invoice', render: (r) => esc(r.number) },
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Customer', render: (r) => esc(r.customer_name || '') },
          { label: 'GSTIN', render: (r) => esc(r.customer_gstin) },
          { label: 'Taxable', num: true, render: (r) => money(r.taxable) },
          { label: 'GST', num: true, render: (r) => money(r.tax) },
          { label: 'Total', num: true, render: (r) => money(r.total) },
        ], g.b2b_invoices, { empty: 'No B2B invoices in this period.' })}
        ${g.b2b_credit_notes.length ? `<h2 style="margin-top:20px">B2B credit notes</h2>${table([
          { label: 'Credit note', render: (r) => esc(r.number) },
          { label: 'Date', render: (r) => esc(dateOnly(r.date)) },
          { label: 'Customer', render: (r) => esc(r.customer_name || '') },
          { label: 'GSTIN', render: (r) => esc(r.customer_gstin) },
          { label: 'Taxable', num: true, render: (r) => money(r.taxable) },
          { label: 'GST', num: true, render: (r) => money(r.tax) },
          { label: 'Total', num: true, render: (r) => money(r.total) },
        ], g.b2b_credit_notes)}` : ''}
        <p class="muted" style="margin-top:12px">Other (walk-in) sales: ${g.b2c.invoices} invoices, taxable ${money(g.b2c.taxable)}, GST ${money(g.b2c.tax)}.</p>`;
      csv = {
        headers: ['HSN', 'Unit', 'Qty', 'GST %', 'Taxable', 'CGST', 'SGST', 'IGST'],
        rows: g.hsn.map((r) => [r.hsn_code, r.unit || '', r.qty, r.tax_rate, amount(r.taxable), amount(r.cgst), amount(r.sgst), amount(r.igst)]),
      };
    } else if (type === 'valuation') {
      const v = await api('GET', '/reports/valuation');
      body = `<div class="grid">${kpi('Stock value at cost', money(v.total))}</div>
        <div style="margin-top:16px">${table([
          { label: 'SKU', render: (r) => esc(r.sku) },
          { label: 'Product', render: (r) => esc(r.name) },
          { label: 'Qty', num: true, render: (r) => `${num(r.qty)} ${esc(r.unit)}` },
          { label: 'Unit cost', num: true, render: (r) => money(r.cost) },
          { label: 'Value', num: true, render: (r) => money(r.value) },
        ], v.items)}</div>`;
      csv = { headers: ['SKU', 'Product', 'Qty', 'Unit cost', 'Value'], rows: v.items.map((r) => [r.sku, r.name, r.qty, amount(r.cost), amount(r.value)]) };
    } else if (type === 'receivables' || type === 'payables') {
      const rows = await api('GET', `/reports/${type}`);
      const aging = type === 'receivables';
      body = table([
        { label: 'Name', render: (r) => esc(r.name) },
        ...(aging ? [
          { label: 'Current', num: true, render: (r) => money(r.aging.current) },
          { label: '31–60', num: true, render: (r) => money(r.aging.days31to60) },
          { label: '61–90', num: true, render: (r) => money(r.aging.days61to90) },
          { label: 'Over 90', num: true, render: (r) => money(r.aging.over90) },
        ] : []),
        { label: 'Balance', num: true, render: (r) => money(r.balance) },
      ], rows, { rowLink: (r) => `#/${aging ? 'customer' : 'supplier'}/${r.id}`, empty: aging ? 'Nobody owes you money.' : 'You owe nothing.' });
      csv = {
        headers: aging ? ['Customer', 'Current', '31-60', '61-90', 'Over 90', 'Balance'] : ['Supplier', 'Balance'],
        rows: rows.map((r) => (aging
          ? [r.name, amount(r.aging.current), amount(r.aging.days31to60), amount(r.aging.days61to90), amount(r.aging.over90), amount(r.balance)]
          : [r.name, amount(r.balance)])),
      };
    }

    state.report = csv;
    const tabsHtml = tabs.map(([id, label]) => `<a class="btn ${id === type ? 'primary' : ''}" href="#/reports?type=${id}&from=${filters.from}&to=${filters.to}">${esc(label)}</a>`).join(' ');
    return {
      html: `<div class="toolbar"><h1>Reports</h1><div class="row no-print">${csv ? '<button type="button" data-action="report-csv">Export CSV</button>' : ''}<button type="button" data-action="print">Print</button></div></div>
        <div class="row no-print" style="margin-bottom:12px">${tabsHtml}</div>
        <form class="panel row no-print" data-submit="filter" data-page="reports">
          <input type="hidden" name="type" value="${esc(type)}">
          <label>From <input type="date" name="from" value="${esc(filters.from)}"></label>
          <label>To <input type="date" name="to" value="${esc(filters.to)}"></label>
          <button type="submit">Run report</button>
        </form>
        <section class="panel">${body}</section>`,
    };
  };

  PAGES.settings = async () => {
    if (!isAdmin()) return { html: '<div class="panel">Only administrators can change settings.</div>' };
    const [users, warehouses, sync, devices] = await Promise.all([
      api('GET', '/users'), api('GET', '/warehouses'), api('GET', '/sync/status'), api('GET', '/sync/devices'),
    ]);
    const s = state.settings;
    return {
      html: `<div class="toolbar"><h1>Settings</h1></div>
        <form class="panel" data-submit="company-save">
          <h2>Shop and receipts</h2>
          <div class="grid">
            <label>Shop name <input name="company_name" value="${esc(s.company_name)}" required></label>
            <label>Phone <input name="company_phone" value="${esc(s.company_phone)}"></label>
            <label>Address <input name="company_address" value="${esc(s.company_address)}"></label>
            <label>GSTIN <input name="company_gstin" maxlength="15" value="${esc(s.company_gstin)}"></label>
            <label>Shop state <select name="company_state_code">${stateOptions(s.company_state_code)}</select></label>
            <label>PAN <input name="company_pan" maxlength="10" value="${esc(s.company_pan)}"></label>
            <label>Currency symbol <input name="currency" value="${esc(s.currency)}" maxlength="6"></label>
            <label>Default GST rate for new products <select name="default_tax_rate" data-kind="num">${gstOptions(s.default_tax_rate)}</select></label>
          </div>
          <label style="margin-top:12px">Receipt footer <input name="receipt_footer" value="${esc(s.receipt_footer)}"></label>
          <label class="inline" style="margin-top:12px"><input type="checkbox" name="prices_include_gst" ${s.prices_include_gst ? 'checked' : ''}> Selling prices include GST (MRP style)</label>
          <label class="inline" style="margin-top:12px"><input type="checkbox" name="round_invoice_totals" ${s.round_invoice_totals ? 'checked' : ''}> Round invoice totals to the rupee</label>
          <label class="inline" style="margin-top:12px"><input type="checkbox" name="allow_negative_stock" ${s.allow_negative_stock ? 'checked' : ''}> Allow selling items that are out of stock</label>
          <div style="margin-top:12px"><button class="primary" type="submit">Save settings</button></div>
        </form>

        <section class="panel">
          <h2>Warehouses</h2>
          ${table([{ label: 'Code', render: (r) => esc(r.code) }, { label: 'Name', render: (r) => esc(r.name) }, { label: 'Address', render: (r) => esc(r.address || '') }], warehouses)}
          <form data-submit="warehouse-add" class="row" style="margin-top:12px">
            <label>Code <input name="code" required></label>
            <label>Name <input name="name" required></label>
            <label style="flex:1">Address <input name="address"></label>
            <button type="submit">Add warehouse</button>
          </form>
        </section>

        <section class="panel">
          <h2>Users</h2>
          ${table([
            { label: 'Username', render: (r) => esc(r.username) },
            { label: 'Name', render: (r) => esc(r.name) },
            { label: 'Role', render: (r) => esc(r.role) },
            { label: 'Status', render: (r) => (r.active ? '<span class="badge ok">active</span>' : '<span class="badge bad">disabled</span>') },
          ], users)}
          <details style="margin-top:12px"><summary>Add or change a user</summary>
            <form data-submit="user-add" class="grid" style="margin-top:12px">
              <label>Username <input name="username" required></label>
              <label>Full name <input name="name"></label>
              <label>Role <select name="role"><option>cashier</option><option>manager</option><option>admin</option></select></label>
              <label>Password <input name="password" type="password" minlength="6" required></label>
              <div><button type="submit">Create user</button></div>
            </form>
            ${users.map((u) => `<form data-submit="user-update" data-id="${esc(u.id)}" class="row" style="margin-top:8px">
              <strong style="min-width:140px">${esc(u.username)}</strong>
              <label>Role <select name="role">${['cashier', 'manager', 'admin'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
              <label class="inline"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label>
              <label>New password <input type="password" name="password" minlength="6" placeholder="unchanged"></label>
              <button type="submit">Update</button></form>`).join('')}
          </details>
        </section>

        <section class="panel">
          <h2>Hosted server sync</h2>
          <p class="muted">Leave the server address empty to run fully offline. When an address is set, this machine pushes its changes to the server and pulls the server's changes, every minute and on demand.</p>
          <div class="grid">
            ${kpi('Status', sync.configured ? 'Connected to server' : 'Offline only')}
            ${kpi('Pending changes', sync.pending, sync.pending > 0)}
            ${kpi('Last sync', sync.last_sync ? new Date(sync.last_sync).toLocaleString() : 'Never')}
          </div>
          ${sync.last_error ? `<p class="badge bad" style="margin-top:12px">Last error: ${esc(sync.last_error)}</p>` : ''}
          <form data-submit="sync-config" class="row" style="margin-top:12px">
            <label style="flex:1">Server address <input name="url" value="${esc(sync.url || '')}" placeholder="https://shop.example.com"></label>
            <label style="flex:1">Device token <input name="token" type="password" placeholder="${sync.configured ? 'unchanged' : 'paste token from the server'}"></label>
            <button type="submit">Save connection</button>
            <button type="button" data-action="sync-now" ${sync.configured ? '' : 'disabled'}>Sync now</button>
          </form>
          <h3 style="margin-top:20px">Devices allowed to sync with this server</h3>
          ${table([
            { label: 'Device', render: (r) => esc(r.name) },
            { label: 'Added', render: (r) => esc(dateOnly(r.created_at)) },
            { label: 'Status', render: (r) => (r.revoked ? '<span class="badge bad">revoked</span>' : '<span class="badge ok">allowed</span>') },
            { label: '', render: (r) => (r.revoked ? '' : `<button type="button" class="danger" data-action="device-revoke" data-id="${esc(r.id)}">Revoke</button>`) },
          ], devices, { empty: 'No devices yet.' })}
          <form data-submit="device-add" class="row" style="margin-top:12px">
            <label style="flex:1">Device name <input name="name" placeholder="e.g. Counter 2"></label>
            <button type="submit">Create device token</button>
          </form>
          <div id="device-token"></div>
        </section>

        <section class="panel">
          <h2>Backup</h2>
          <p class="muted">Downloads a full copy of the shop database.</p>
          <button type="button" data-action="backup">Download backup</button>
        </section>`,
    };
  };

  // ---- actions (buttons) ----------------------------------------------------------------

  const ACTIONS = {
    async logout() {
      try { await api('POST', '/auth/logout'); } catch { /* session may already be gone */ }
      signedOut();
      render();
    },

    print() { window.print(); },

    'filter-clear'(el) {
      go(el.dataset.page);
    },

    'pos-add'(el) {
      const product = state.products.get(el.dataset.id);
      if (product) addToCart(product);
    },

    'pos-line-remove'(el) {
      state.pos.lines.splice(Number(el.dataset.idx), 1);
      renderPosCart();
    },

    'pos-clear'() {
      state.pos = { ...newCart(), warehouseId: state.pos.warehouseId };
      renderPosCart();
    },

    async 'pos-quote'() {
      const sale = await api('POST', '/quotes', posPayload());
      toast(`Quote ${sale.number} saved`);
      state.pos = { ...newCart(), warehouseId: state.pos.warehouseId };
      goTo(`#/sale/${sale.id}`);
    },

    async 'pos-complete'() {
      const body = posPayload();
      const sale = state.pos.quoteId
        ? await api('POST', `/quotes/${state.pos.quoteId}/convert`, { ...body })
        : await api('POST', '/sales', body);
      toast(`Sale ${sale.number} completed`);
      state.pos = { ...newCart(), warehouseId: state.pos.warehouseId };
      goTo(`#/sale/${sale.id}`);
    },

    async 'quote-convert'(el) {
      await loadQuoteIntoPos(el.dataset.id);
    },

    async 'quote-cancel'(el) {
      if (!confirm('Cancel this quote?')) return;
      await api('POST', `/quotes/${el.dataset.id}/cancel`);
      toast('Quote cancelled');
      render();
    },

    async 'category-delete'(el) {
      if (!confirm('Delete this category?')) return;
      await api('DELETE', `/categories/${el.dataset.id}`);
      state.categories = await api('GET', '/categories');
      toast('Category deleted');
      render();
    },

    async 'po-line-add'() {
      const productId = $('#po-product').value;
      const product = state.products.get(productId);
      if (!product) throw new Error('Choose a product');
      const qty = parseFloat($('#po-qty').value);
      const cost = toCents($('#po-cost').value);
      if (!(qty > 0)) throw new Error('Quantity must be greater than zero');
      state.po.lines.push({ productId, name: product.name, qty, unitCost: cost, taxRate: product.tax_rate });
      renderPoLines();
    },

    'po-line-remove'(el) {
      state.po.lines.splice(Number(el.dataset.idx), 1);
      renderPoLines();
    },

    async 'po-order'(el) {
      await api('POST', `/purchases/${el.dataset.id}/order`);
      toast('Order placed with supplier');
      render();
    },

    async 'po-receive'(el) {
      if (!confirm('Receive all goods on this order into stock?')) return;
      await api('POST', `/purchases/${el.dataset.id}/receive`, {});
      toast('Goods received into stock');
      render();
    },

    async 'po-cancel'(el) {
      if (!confirm('Cancel this purchase order?')) return;
      await api('POST', `/purchases/${el.dataset.id}/cancel`);
      toast('Purchase order cancelled');
      render();
    },

    async 'expense-delete'(el) {
      if (!confirm('Delete this expense?')) return;
      await api('DELETE', `/expenses/${el.dataset.id}`);
      toast('Expense deleted');
      render();
    },

    async 'report-csv'() {
      if (!state.report) return;
      download(`report-${route().query.get('type') || 'report'}.csv`, toCsv(state.report.headers, state.report.rows), 'text/csv');
    },

    async backup() {
      await downloadFile('/admin/backup', 'erp-backup.db');
      toast('Backup downloaded');
    },

    async 'sync-now'() {
      const result = await api('POST', '/sync/now');
      toast(`Synced: ${result.pushed} sent, ${result.pulled} received`);
      render();
    },

    async 'device-revoke'(el) {
      if (!confirm('Revoke this device? It will stop syncing.')) return;
      await api('DELETE', `/sync/devices/${el.dataset.id}`);
      toast('Device revoked');
      render();
    },
  };

  // ---- form submissions -----------------------------------------------------------------

  const SUBMITS = {
    async login(form) {
      const { token, user } = await api('POST', '/auth/login', readForm(form));
      state.token = token;
      safeSet('erp_token', token);
      state.user = user;
      await boot(true);
    },

    async setup(form) {
      const data = readForm(form);
      await api('POST', '/setup', { username: data.username, name: data.name, password: data.password });
      const { token, user } = await api('POST', '/auth/login', { username: data.username, password: data.password });
      state.token = token;
      safeSet('erp_token', token);
      state.user = user;
      await api('PUT', '/settings', { company_name: data.company_name });
      await boot(true);
    },

    async filter(form) {
      const page = form.dataset.page;
      const params = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.type === 'checkbox') { if (el.checked) params[el.name] = el.value; continue; }
        params[el.name] = el.value;
      }
      go(page, params);
    },

    async 'product-save'(form) {
      const data = readForm(form);
      const id = form.dataset.id;
      const product = id ? await api('PUT', `/products/${id}`, data) : await api('POST', '/products', data);
      toast('Product saved');
      goTo(`#/product/${product.id}`);
    },

    async 'category-add'(form) {
      const data = readForm(form);
      await api('POST', '/categories', data);
      state.categories = await api('GET', '/categories');
      toast('Category added');
      render();
    },

    async 'warehouse-add'(form) {
      await api('POST', '/warehouses', readForm(form));
      state.warehouses = await api('GET', '/warehouses');
      toast('Warehouse added');
      render();
    },

    async 'company-save'(form) {
      state.settings = await api('PUT', '/settings', readForm(form));
      toast('Settings saved');
      render();
    },

    async 'customer-save'(form) {
      const data = readForm(form);
      const id = form.dataset.id;
      const customer = id ? await api('PUT', `/customers/${id}`, data) : await api('POST', '/customers', data);
      toast('Customer saved');
      goTo(`#/customer/${customer.id}`);
    },

    async 'supplier-save'(form) {
      const data = readForm(form);
      const id = form.dataset.id;
      const supplier = id ? await api('PUT', `/suppliers/${id}`, data) : await api('POST', '/suppliers', data);
      toast('Supplier saved');
      goTo(`#/supplier/${supplier.id}`);
    },

    async 'customer-receive'(form) {
      const data = readForm(form);
      await api('POST', '/payments/receive', { customerId: form.dataset.id, amount: data.amount, method: data.method, docId: data.docId || null });
      toast('Receipt recorded');
      render();
    },

    async 'customer-refund'(form) {
      const data = readForm(form);
      await api('POST', '/payments/refund', { customerId: form.dataset.id, amount: data.amount, method: data.method });
      toast('Refund recorded');
      render();
    },

    async 'supplier-pay'(form) {
      const data = readForm(form);
      await api('POST', '/payments/pay-supplier', { supplierId: form.dataset.id, amount: data.amount, method: data.method, note: data.note });
      toast('Payment recorded');
      render();
    },

    async 'expense-add'(form) {
      await api('POST', '/expenses', readForm(form));
      toast('Expense saved');
      render();
    },

    async 'stock-count'(form) {
      const counted = parseFloat(form.elements.counted.value);
      if (!(counted >= 0)) throw new Error('Enter the counted quantity');
      const result = await api('POST', '/inventory/adjust', {
        productId: form.dataset.product, warehouseId: form.dataset.warehouse, countedQty: counted,
      });
      toast(result.id ? 'Stock adjusted' : 'Count matches the system');
      render();
    },

    async 'stock-transfer'(form) {
      await api('POST', '/inventory/transfer', readForm(form));
      toast('Stock transferred');
      render();
    },

    async 'po-save'(form) {
      if (!state.po.lines.length) throw new Error('Add at least one item');
      const data = readForm(form);
      const body = {
        supplierId: data.supplierId,
        warehouseId: data.warehouseId,
        date: data.date,
        note: data.note,
        lines: state.po.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost, taxRate: l.taxRate })),
      };
      const id = form.dataset.id;
      const order = id ? await api('PUT', `/purchases/${id}`, body) : await api('POST', '/purchases', body);
      toast(`Purchase order ${order.number} saved`);
      goTo(`#/purchase/${order.id}`);
    },

    async 'sale-return'(form) {
      const sale = state.sale;
      const lines = [];
      sale.lines.forEach((l, i) => {
        const qty = parseFloat(form.elements[`qty_${i}`].value || 0);
        if (qty > 0) lines.push({ productId: l.product_id, qty });
      });
      if (!lines.length) throw new Error('Enter the quantity to return');
      const data = readForm(form);
      let refund = data.refund;
      if (!sale.customer_id) {
        refund = sale.lines.reduce((sum, l) => {
          const picked = lines.find((x) => x.productId === l.product_id);
          if (!picked) return sum;
          const amount = Math.round(picked.qty * l.unit_price * (1 - l.discount_pct / 100));
          if (state.settings.prices_include_gst) return sum + amount;
          return sum + amount + Math.round((amount * l.tax_rate) / 100);
        }, 0);
        // Credit notes are rounded the same way as invoices, so a walk-in refund matches exactly.
        if (state.settings.round_invoice_totals) refund = Math.round(refund / 100) * 100;
      }
      const result = await api('POST', `/sales/${sale.id}/return`, {
        lines,
        refunds: refund > 0 ? [{ method: data.method, amount: refund }] : [],
        note: data.note,
      });
      toast(`Return ${result.number} recorded`);
      goTo(`#/sale/${result.id}`);
    },

    async 'user-add'(form) {
      await api('POST', '/users', readForm(form));
      toast('User created');
      render();
    },

    async 'user-update'(form) {
      const data = readForm(form);
      if (!data.password) delete data.password;
      await api('PUT', `/users/${form.dataset.id}`, data);
      toast('User updated');
      render();
    },

    async 'sync-config'(form) {
      const data = readForm(form);
      const body = { url: data.url };
      if (data.token) body.token = data.token;
      await api('PUT', '/sync/config', body);
      toast('Connection saved');
      render();
    },

    async 'device-add'(form) {
      const device = await api('POST', '/sync/devices', { name: readForm(form).name });
      $('#device-token').innerHTML = `<div class="panel" style="margin-top:12px">
        <p>Copy this token into the other machine's <strong>Hosted server sync</strong> settings. It is shown only once.</p>
        <pre class="json">${esc(device.token)}</pre></div>`;
      toast('Device created');
    },
  };

  // ---- wiring -------------------------------------------------------------------------

  async function run(task) {
    try {
      await task();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  document.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-href]');
    if (row && !event.target.closest('button, a, input, select, textarea, form')) {
      goTo(row.dataset.href);
      return;
    }
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    event.preventDefault();
    const action = ACTIONS[el.dataset.action];
    if (action) run(() => action(el));
  });

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form.dataset || !form.dataset.submit) return;
    event.preventDefault();
    const submit = SUBMITS[form.dataset.submit];
    if (submit) run(() => submit(form));
  });

  let searchTimer = null;
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (el.dataset.on === 'pos-search') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => run(() => searchPos(el.value)), 200);
    } else if (el.dataset.on === 'pos-tender') {
      state.pos.tender = el.value;
      updatePosTotals();
    }
  });

  document.addEventListener('change', (event) => {
    const el = event.target;
    const on = el.dataset.on;
    if (on === 'pos-line') {
      const line = state.pos.lines[Number(el.dataset.idx)];
      if (!line) return;
      const field = el.dataset.field;
      const value = field === 'unitPrice' ? toCents(el.value) : Number(el.value);
      if (field === 'qty' && !(value > 0)) return renderPosCart();
      line[field] = value;
      renderPosCart();
    } else if (on === 'pos-customer') {
      state.pos.customerId = el.value;
      renderPosCart();
    } else if (on === 'pos-warehouse') {
      state.pos.warehouseId = el.value;
    } else if (on === 'pos-method') {
      state.pos.method = el.value;
    }
  });

  document.addEventListener('keydown', (event) => {
    const el = event.target;
    if (event.key !== 'Enter' || el.dataset.enter !== 'pos-scan') return;
    event.preventDefault();
    const code = el.value.trim();
    if (!code) return;
    run(async () => {
      try {
        const product = await api('GET', `/products/code/${encodeURIComponent(code)}`);
        state.products.set(product.id, product);
        addToCart(product);
        el.value = '';
        $('#pos-results').innerHTML = '';
        el.focus();
      } catch {
        await searchPos(code);
      }
    });
  });

  window.addEventListener('hashchange', () => { render(); });

  async function boot(afterLogin = false) {
    state.status = await api('GET', '/status');
    if (state.status.needsSetup) return renderSetup();
    if (!state.user && state.token) {
      try {
        state.user = await api('GET', '/me');
      } catch {
        signedOut();
      }
    }
    if (!state.user) return renderLogin();
    await loadShared();
    if (afterLogin && !location.hash) goTo('#/dashboard');
    return render();
  }

  boot().catch((err) => {
    app.innerHTML = `<div class="auth"><div class="panel"><h2>Cannot reach the shop server</h2><p>${esc(err.message)}</p></div></div>`;
  });
})();
