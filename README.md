# Hardware ERP

An ERP for a hardware shop. One codebase runs in three ways:

| How it runs | What it is | Needs network? |
| --- | --- | --- |
| **Desktop, local mode** | Electron app with its own database on the computer. | No. Optional sync with a hosted server. |
| **Desktop, remote mode** | Electron window that opens a hosted server. | Yes |
| **Hosted server** | Node web server, used from any browser. Also the hub that desktops sync with. | Yes (it is the server) |

The core has no runtime dependencies. It uses Node.js 22.13+ and its built-in `node:sqlite`, so there is nothing native to compile, including for Electron.

This version is set up for **India**: rupees with Indian digit grouping, GST on every sale and purchase, tax invoices and credit notes, and an April-to-March financial year. See [India: GST and rupees](#india-gst-and-rupees).

## Features

- **Point of sale**: barcode/SKU scanning, carts with per-line price and discount, tax, cash/card/other tender with change, credit sales on account, save as quote.
- **Sales & returns**: invoices with receipts (print-ready), returns against an invoice with stock restored and refund or credit to the account, quotes converted into invoices.
- **Products**: SKU, barcode, categories, supplier, unit, cost, price, tax rate, reorder level, shelf location, active/inactive.
- **Inventory**: stock per warehouse, stock counts, transfers between warehouses, low-stock list, movement history. Stock is an append-only ledger, so history is never edited.
- **Purchasing**: purchase orders (draft, ordered, received, cancelled). Receiving posts stock in and updates the product's weighted-average cost.
- **Customers and suppliers**: credit limits, opening balances, balances, FIFO receivables aging, statements, receipts, refunds of credit, supplier payments.
- **Expenses** by category.
- **Reports**: dashboard, profit and loss, sales by day, GST returns (GSTR-1 and GSTR-3B style figures, HSN summary, B2B invoices), top products, stock valuation, receivables aging, payables. CSV export for each report.
- **Administration**: first-run setup, users with roles (admin, manager, cashier), settings, warehouses, device tokens for sync, database backup download.

Roles: **cashiers** sell, take returns and manage customers. **Managers** also manage products, stock, purchasing, expenses and reports. **Admins** also manage users, settings and sync.

## India: GST and rupees

**What the app does for GST**

- **GST on every line.** Each product has an HSN code (4, 6 or 8 digits) and a GST rate. Sales show taxable value, GST and amount per line.
- **CGST + SGST or IGST, chosen automatically.** A sale to a customer in the shop's own state carries CGST and SGST (half the GST each). A sale to another state carries IGST. The customer's state comes from their GSTIN, or from the state they are set to. Walk-in sales are treated as in-state. A credit note keeps the tax type of the invoice it reverses.
- **Prices with GST included (MRP style).** This is the default. Turn it off in Settings if your prices are entered before GST. Both ways, a line's amount and its GST add up to the amount the customer pays.
- **Round-off.** Invoice totals are rounded to the rupee by default, and the difference is shown as round-off. Turn this off in Settings if you don't round.
- **Tax invoice.** Shows the shop's GSTIN and state, the customer's GSTIN, place of supply, HSN and GST per line, CGST/SGST or IGST totals, round-off, and the amount in words (for example "Rupees Nine Hundred Only").
- **Invoice numbers.** Restart each financial year (1 April to 31 March) and stay within GST's 16-character limit: `SHP/26-27/00001` for invoices, `C-SHP/26-27/0001` for credit notes, `Q-SHP/26-27/0001` for quotes. `SHP` is the terminal code (up to 3 characters, unique per machine).
- **GSTIN checks.** GSTINs are checked for format, state code and check digit, and PAN for format. A GSTIN fills in the customer's state.
- **GST returns figures** (Reports → GST returns): output GST on sales less credit notes, input tax credit on purchases from suppliers, the net payable (a negative figure carries forward), the HSN-wise summary by rate, and B2B invoices and credit notes.
- **Input tax credit.** Purchases are recorded before GST. The GST on a purchase order is counted as input tax credit when the goods are received.

**Tax invoice or bill of supply, chosen for each bill**

At the point of sale, pick **Bill type**: *Tax invoice (with GST)* or *Bill of supply (no GST)*. The same choice is available on quotes. The default for new bills comes from Settings.

- **Bill of supply:** no GST, HSN, GSTIN or place-of-supply lines. The total is the price. Headed "Bill of supply". A return on it is a "Refund note".
- **Tax invoice:** full GST as described above.
- **Returns follow the original bill.** A credit note on a tax invoice reverses its GST, and a refund note on a bill of supply has no tax.
- **GST return figures** include tax invoices only. Bills of supply still show in all sales reports.

Settings:

- **This shop is registered for GST.** Turn this off if the shop is not registered. Then only bills of supply can be issued, the GST returns tab is hidden, and purchases record no input credit.
- **New bills start with GST ticked.** The default for the bill-type selector. Only available when the shop is registered.

Each bill stores its own bill type, so changing the settings never changes earlier bills.

**What to check with your CA before you file**

- **GST rates.** Rates change by notification. Each product's rate is entered by you, and the options offered (0, 0.25, 3, 5, 12, 18, 28%) are only the slabs. Confirm the current rate and HSN code for every item you sell.
- **The GST return figures are not a filed return.** They show the numbers to file from, in the layout of GSTR-1 and GSTR-3B. Filing itself is done on the GST portal or with your accountant's software.
- **Units.** The app's unit names (pcs, kg, box) are not GST unit codes (for example NOS, KGS). Map them when you file.

**Not included for India (yet)**

- E-invoicing (IRN and QR code), which is required above the turnover limit for B2B invoices.
- E-way bills for moving goods.
- TDS and TCS deduction.
- Composition-scheme invoices (bill of supply), and reverse-charge invoices.
- Direct filing to the GST portal.

**Other Indian formats**

- Money shows as ₹1,23,45,678.00 (lakh and crore grouping).
- Dates show as dd-mm-yyyy.
- Shop settings: GSTIN, state, PAN, and whether prices include GST.

**Upgrading an earlier build.** This version changes the database layout (GST fields on products, customers, suppliers, sales, credit notes, purchases and lines). Databases created by the earlier, non-India build are not migrated. Start a new database, or export the data you need and re-enter it.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
npm test                              # 61 tests
PORT=8080 node bin/erp-server.js      # hosted server at http://localhost:8080
```

Open the address, create the admin account on the first screen, and start adding products.

Environment variables for the server:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ERP_DATA_DIR` | `./data` | Folder for `erp.db` and backups |
| `ERP_TERMINAL` | `WEB` | Terminal code in document numbers (`WEB/26-27/00001`). Up to 3 characters, unique per machine. |

Run it behind HTTPS (a reverse proxy such as Caddy or nginx) before exposing it on the internet, because it handles passwords and sales data.

## Desktop app

```bash
npm install            # installs Electron (devDependency)
npm run start:desktop  # runs the desktop app
npm run build:desktop  # builds an installer with electron-builder
```

The desktop reads `config.json` in its user-data folder. It is created on first run:

```json
{ "mode": "local", "remoteUrl": "", "terminalCode": "P1", "syncIntervalMs": 60000 }
```

- `mode: "local"` runs the full ERP on this computer, with its own database in the user-data folder (`erp.db`). It works with no network at all.
- `mode: "remote"` opens `remoteUrl` (for example `https://shop.example.com`) in the window instead. Nothing is stored locally.
- `terminalCode` must be unique for each desktop, so their document numbers never clash. Use up to 3 letters or digits, such as `P1`, `P2`.

The local server listens on `127.0.0.1` on a free port, and only the app's own window talks to it. Only one copy of the app can run at a time, because two copies would share one database file.

## Building installers (Windows, macOS, Linux)

The workflow `.github/workflows/build-desktop.yml` builds the desktop app for all three systems:

| Platform | Installer |
| --- | --- |
| Windows (x64) | `hardware-erp-<version>-win-x64-setup.exe` (NSIS installer) |
| macOS (Apple Silicon and Intel) | `hardware-erp-<version>-mac-arm64.dmg`, `…-mac-x64.dmg`, and matching `.zip` |
| Linux (x64) | `hardware-erp-<version>-linux-x86_64.AppImage` |

**To release:** update `version` in `package.json`, commit, then push a tag with the same version:

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow runs the tests, builds all three installers and attaches them to a GitHub release for that tag. Every push and pull request runs the tests only. You can also run the build by hand from the Actions tab (**Run workflow**). Its installers are kept as workflow artifacts for 30 days.

**Signing (optional).** Without signing secrets the installers are unsigned. Windows will show a "Windows protected your PC" warning, and macOS will refuse to open the app until it is allowed in System Settings. To sign:

- Windows: add the secrets `WIN_CSC_LINK` (a base64 or URL link to your `.pfx` code-signing certificate) and `WIN_CSC_KEY_PASSWORD`.
- macOS: add `MAC_CSC_LINK` (your Developer ID `.p12`), `MAC_CSC_KEY_PASSWORD`, and for notarization `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Also set the repository variable `SIGN_MACOS` to `true`.

**Local builds.** `npm install`, then `npm run build:desktop` builds for the system you are on, into `dist/`.

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
- `test/bill_type.test.js`: choosing tax invoice or bill of supply per bill, registration rules, returns and quotes keeping their bill type, purchases, and GST report filtering.
- `test/india.test.js`: GSTIN and PAN checks, CGST/SGST versus IGST, GST-inclusive pricing, round-off, amounts in words, financial-year numbering, credit notes, input tax credit, and the GST return figures.
