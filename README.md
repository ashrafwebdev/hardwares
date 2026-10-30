# Hardware ERP

An ERP for a hardware shop. One codebase runs in three ways:

| How it runs | What it is | Needs network? |
| --- | --- | --- |
| **Desktop, local mode** | Electron app with its own database on the computer. | No. Optional sync with a hosted server. |
| **Desktop, remote mode** | Electron window that opens a hosted server. | Yes |
| **Hosted server** | Node web server, used from any browser. Also the hub that desktops sync with. | Yes (it is the server) |

The core has no runtime dependencies. It uses Node.js 22.13+ and its built-in `node:sqlite`, so there is nothing native to compile, including for Electron.

## Features

- **Point of sale**: barcode/SKU scanning, carts with per-line price and discount, tax, cash/card/other tender with change, credit sales on account, save as quote.
- **Sales & returns**: invoices with receipts (print-ready), returns against an invoice with stock restored and refund or credit to the account, quotes converted into invoices.
- **Products**: SKU, barcode, categories, supplier, unit, cost, price, tax rate, reorder level, shelf location, active/inactive.
- **Inventory**: stock per warehouse, stock counts, transfers between warehouses, low-stock list, movement history. Stock is an append-only ledger, so history is never edited.
- **Purchasing**: purchase orders (draft, ordered, received, cancelled). Receiving posts stock in and updates the product's weighted-average cost.
- **Customers and suppliers**: credit limits, opening balances, balances, FIFO receivables aging, statements, receipts, refunds of credit, supplier payments.
- **Expenses** by category.
- **Reports**: dashboard, profit and loss, sales by day, top products, stock valuation, receivables aging, payables. CSV export for each report.
- **Administration**: first-run setup, users with roles (admin, manager, cashier), settings, warehouses, device tokens for sync, database backup download.

Roles: **cashiers** sell, take returns and manage customers. **Managers** also manage products, stock, purchasing, expenses and reports. **Admins** also manage users, settings and sync.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
npm test                              # 30 tests
PORT=8080 node bin/erp-server.js      # hosted server at http://localhost:8080
```

Open the address, create the admin account on the first screen, and start adding products.

Environment variables for the server:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ERP_DATA_DIR` | `./data` | Folder for `erp.db` and backups |
| `ERP_TERMINAL` | `WEB` | Prefix for document numbers (`WEB-INV-000001`). Must be unique per machine. |

Run it behind HTTPS (a reverse proxy such as Caddy or nginx) before exposing it on the internet, because it handles passwords and sales data.

## Desktop app

```bash
npm install            # installs Electron (devDependency)
npm run start:desktop  # runs the desktop app
npm run build:desktop  # builds an installer with electron-builder
```

The desktop reads `config.json` in its user-data folder. It is created on first run:

```json
{ "mode": "local", "remoteUrl": "", "terminalCode": "POS1", "syncIntervalMs": 60000 }
```

- `mode: "local"` runs the full ERP on this computer, with its own database in the user-data folder (`erp.db`). It works with no network at all.
- `mode: "remote"` opens `remoteUrl` (for example `https://shop.example.com`) in the window instead. Nothing is stored locally.
- `terminalCode` must be unique for each desktop, so their document numbers never clash.

The local server listens on `127.0.0.1` on a free port, and only the app's own window talks to it. Only one copy of the app can run at a time, because two copies would share one database file.

## Working offline and syncing with a hosted server

Each machine keeps a full copy of the data. Sync is optional and can be turned on at any time.

1. On the hosted server, sign in as an admin, open **Settings → Devices allowed to sync**, enter a name, and click **Create device token**. Copy the token. It is shown only once.
2. On the desktop, open **Settings → Hosted server sync**, enter the server address and the token, and click **Save connection**. Then click **Sync now**. The desktop also syncs every minute while it runs.
3. To go back to offline-only, clear the server address and save.

How sync works:

- **Changes are pushed and pulled.** Every saved record is marked as changed. A sync sends those changes to the server, then fetches everything the server has changed since the last sync.
- **Conflicts**: when the same record is edited on two machines, the later edit wins (last write wins, by the time it was saved). Stock is never a conflict, because stock is a ledger of movements. Each machine adds its movements, and the server keeps all of them.
- **Records are never hard-deleted** during sync. Products and customers are deactivated, and documents are cancelled or returned, so history is kept.
- **Document numbers** include the machine's terminal code, so offline machines never produce the same number.
- **Revoking a device** in the hosted server stops it syncing at its next attempt.

Known limits of sync:

- Last-write-wins relies on the clocks of the machines being roughly right. Keep the computers' clocks synced (Windows time service, NTP).
- Sync protocol: the server accepts JSON over HTTP(S). Use HTTPS.
- Users and sessions are not synced. Each machine has its own user list, and the hosted server has its own. Create the users on each machine that needs them.

## Project layout

```
bin/erp-server.js        hosted server entry point
desktop/main.js          Electron shell (local and remote modes)
src/core/                business logic and database (no UI, no HTTP)
  schema.js              tables. The single source of truth for the database.
  db.js, repo.js         SQLite access, transactions, synced-row writes
  sales.js               invoices, returns, quotes
  purchasing.js          purchase orders and goods receipt
  inventory.js           stock ledger, counts, transfers
  finance.js             receipts, refunds, supplier payments, expenses
  ledger.js              customer and supplier balances, FIFO aging
  master.js              categories, warehouses, products, customers, suppliers
  reports.js             dashboard and reports
  sync.js                sync protocol (both the hub and the desktop side)
  auth.js, settings.js   users, sessions, device tokens, shop settings
src/server/app.js        HTTP routes, roles, static files
src/web/                 the browser app (plain JavaScript, no build step)
test/                    unit and integration tests
```

Money is stored as integer cents (`2550` means 25.50). Quantities are decimals to three places. Dates are `YYYY-MM-DD` in the shop's local time.

## Data safety

- **Backups**: admins can download a full copy of the database from **Settings → Backup**. The file is a normal SQLite database. Keep copies off the machine.
- **Stock and money can only change through documents.** Stock cannot go negative unless the shop allows it in settings. A payment cannot exceed the balance, and a return cannot exceed the quantity sold.
- **Passwords** are hashed with scrypt. Sessions last 30 days and can be ended with **Sign out**.

## Not included (yet)

- Tax filing reports and tax-inclusive pricing. Prices are entered before tax, and tax is added on top.
- Multiple currencies, bank reconciliation and a full double-entry general ledger. The profit and loss report comes from sales, returns, cost of goods and expenses.
- Barcode label printing and a hardware receipt printer driver. Receipts print through the normal browser print dialog.
- Partial goods receipt. A purchase order is received in full.
- Automatic email or SMS to customers.

## Tests

```bash
npm test
```

- `test/core.test.js`: sales, returns, credit limits, receipts, purchasing and average cost, quotes, transfers, low stock, profit and loss, aging, settings.
- `test/sync.test.js`: two desktops and a hub exchange changes, conflicting edits resolve by last write, offline work is queued, and revoked devices are refused.
- `test/server.test.js`: setup, login, roles, the sales API, error responses, static files, backups.
