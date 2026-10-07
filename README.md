# Istrom Inventory Management System

Professional Construction Project Management - Materials and Labour Inventory with multi-project support.

**Tech stack:** FastAPI (backend) + React (frontend). Database: SQLite (default) or PostgreSQL.

## Quick Start

### 1. Install Dependencies

```bash
# Backend
pip install -r backend/requirements.txt

# Frontend
cd frontend && npm install
```

### 2. Configure Authentication and Initialize Database

Copy `.env.example` to `.env` and set `JWT_SECRET` to a unique secret of at least
32 bytes before starting the backend. Generate one with `openssl rand -hex 32`.
For a new database, also set `INITIAL_ADMIN_CODE` to a private setup code.

```bash
cd backend && python schema_init.py
```

### 3. Run the Application

**Option A: Run both together**
```bash
npm run dev
```

**Option B: Run separately**
```bash
# Terminal 1 - Backend (port 8000)
cd backend && uvicorn api.main:app --reload --host 127.0.0.1 --port 8000

# Terminal 2 - Frontend (port 5173)
cd frontend && npm run dev
```

### 4. Access the App

- **URL:** http://localhost:5173
- Choose **Admin**, then **Set up the first administrator account** and enter the existing administrator code (or `INITIAL_ADMIN_CODE` for a new installation).
- Choose the admin password (at least 8 characters). The username is fixed as `Istrom_Admin`; Admin sign-in shows only the password field.
- In **Settings**, create project sites. In **Users**, create individual site-user accounts with a username and temporary password, then assign each to an active project. There is one fixed administrator account.
- Give each person their username and temporary password securely. They must choose their own password on first sign-in.
- The landing page has separate **Admin** and **Site user** sign-in options. Accounts must use the matching sign-in page; access is always determined by the account's saved role and project assignment.
- Shared project-site codes no longer grant access. First-admin setup closes permanently after an administrator account exists.

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (optional, defaults to SQLite `istrominventory.db`)
- `JWT_SECRET` - Required unique secret for JWT tokens (at least 32 bytes)
- `INITIAL_ADMIN_CODE` - Private one-time setup code required when creating a new database
- `ACCESS_CODE_ENCRYPTION_KEY` - Retain the existing key when upgrading encrypted legacy code storage; legacy codes cannot sign in
- `VITE_API_URL` - Frontend API base URL (defaults to `/api` for dev proxy)

## Admin password recovery

Admin sign-in includes **Forgot password?** once the administrator account
exists. Recovery sends a link to one address configured privately on the
backend. Site users continue to have their passwords reset by the admin.

Configure the following in the backend host's environment settings (or the
ignored local `.env` file):

| Setting | Value |
| --- | --- |
| `ADMIN_RECOVERY_EMAIL` | The trusted recovery email |
| `APP_FRONTEND_URL` | Exact frontend origin, also listed in `CORS_ORIGINS` |
| `ADMIN_RECOVERY_PROVIDER` | `resend` (default) |
| `RESEND_API_KEY` | Private Resend API key |
| `RESEND_FROM` | Sender address, e.g. `onboarding@resend.dev` for testing |

Render Free blocks outbound SMTP on ports 25, 465 and 587, so use Resend's
HTTPS email API on that hosting plan. Create a Resend account using the same
email as `ADMIN_RECOVERY_EMAIL`, then save its API key privately on the backend.
The `onboarding@resend.dev` sender can send only to your Resend account email.
For company use or another recipient, verify a company sender domain in Resend
and update `RESEND_FROM` to an address on that domain.
[Render SMTP limits](https://render.com/docs/free),
[Resend testing sender restrictions](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

On a host that permits outbound SMTP, `ADMIN_RECOVERY_PROVIDER=smtp` instead
uses these additional settings:

| Setting | Value |
| --- | --- |
| `SMTP_HOST` | Your mail provider's SMTP server |
| `SMTP_PORT` | `587` for STARTTLS or `465` for implicit TLS |
| `SMTP_SECURITY` | `starttls` or `ssl` |
| `SMTP_USERNAME` | Mail provider username |
| `SMTP_PASSWORD` | Mail provider credential or app-specific password |
| `SMTP_FROM` | Sender address authorized by that provider |

Use HTTPS for the hosted frontend; loopback HTTP is supported locally. Never
put these values in a `VITE_*` variable, Git, or the public login form. Restart
the API after changing settings. Incomplete settings disable recovery and
return a clear error; no reset links or passwords are printed in logs.

Reset links expire after 15 minutes and are stored only as hashes. They work
once, and all outstanding links and existing admin sessions are invalidated
after a successful reset. Normal password changes also invalidate old links.
Changing the recovery email invalidates links sent to the previous address.
Requests are limited by IP and by the administrator's database record; a new
request does not invalidate an earlier valid link. Recovery never reopens
initial admin setup or changes a site user's account. The reset page requires
confirmation of a new password with at least 8 characters, then returns to
normal sign-in. A separate email confirms that the password changed.

Both emails include Istrom's official logo, a responsive HTML layout and a
plain text alternative. The logo is embedded as an inline PNG, so it does not
need a public image server. Templates live in
`backend/api/services/recovery_email_templates.py`.

Verify delivery with the real mail provider before launch, including spam
folders, expired links, repeat use and sign-out on other devices. Automated
tests exercise delivery through a substitute mail transport; they cannot
confirm delivery to your real inbox without configured credentials.

## Hosting checklist

A free pilot can use a Render Static Site for the frontend, one Render Free Web
Service for the API, and a Neon Free PostgreSQL database. Use company-owned
accounts and a private Git repository containing the application source,
including `backend/api/assets/istrom-import-template.xlsx` and the new account
and import files. Keep `.env` files, local databases, backups and credentials
out of Git.

Render's free API sleeps after 15 minutes without incoming traffic and can take
about a minute to wake. Its local filesystem is temporary, so do not host the
SQLite database there. Render's own free PostgreSQL expires after 30 days.
[Render free-service limits](https://render.com/docs/free).
Neon's current free database includes 1 GB storage and 100 CU-hours per month,
with a six-hour restore window. Set up separate daily backups and watch usage.
[Neon free-plan limits](https://neon.com/blog/neon-free-plan-1-gb-per-project).

Before real company use, update the older backend dependency pins and complete
a dependency security review. The local review does not include an external
advisory audit.

### Backend: Render Web Service

| Setting | Value |
| --- | --- |
| Root directory | `backend` |
| Runtime | Python 3.12 (declared in `backend/.python-version`) |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn api.main:app --host 0.0.0.0 --port $PORT --workers 1` |
| Health-check path | `/health` |
| Database | Neon PostgreSQL, in a region near the API |

In the backend host's environment settings, add:

- `DATABASE_URL`: Neon's PostgreSQL connection string, including its SSL setting.
- `JWT_SECRET`: a newly generated private secret of at least 32 bytes.
- `INITIAL_ADMIN_CODE`: a private one-time setup code for a fresh database.
- `CORS_ORIGINS`: the exact HTTPS frontend origin. List both origins with a
  comma if using the provided Render address and a company domain.
- Leave `ENABLE_DOCS` unset.

Startup creates the schema automatically. Use one API worker because live
notification connections and sign-in throttling are held in process memory.
The database pool checks idle connections before reusing them.
For device notifications while the app is closed, also configure
`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT`. In-app live updates
work without these keys; Web Push requires HTTPS and each user's permission.

### Frontend: Render Static Site

| Setting | Value |
| --- | --- |
| Root directory | `frontend` |
| Runtime | Node 22 (declared in `frontend/.node-version`) |
| Build command | `npm ci && npm run build` |
| Publish directory | `dist` |
| Environment setting | `VITE_API_URL=https://YOUR-API.onrender.com` |
| Rewrite | Source `/*`, destination `/index.html`, action **Rewrite** |

Use the API origin without `/api` or a trailing slash: `/api` is only the local
Vite development proxy. Rebuild the frontend whenever `VITE_API_URL` changes.
The rewrite lets refreshing `/inventory`, `/users` and other app routes work.
[Render SPA rewrites](https://render.com/docs/redirects-rewrites).

Set frontend response headers on `/*`: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. Set revalidation
headers for `index.html` and `sw.js` so users receive deployments promptly.
HTTPS is managed by Render. Optionally connect
`inventory.istromgroup.com.ng` after confirming company DNS access, then update
`CORS_ORIGINS` for it.
[Render static-site settings](https://render.com/docs/static-sites).

### Data, accounts and launch verification

Choose a fresh database or migrate the existing local records. Changing
`DATABASE_URL` does not transfer SQLite records to PostgreSQL. For a migration,
take a backup and verify record counts, budgets, Actuals and account history
before switching users over.

For a fresh database, complete first-administrator setup immediately, then
create project sites and individual site-user accounts. Give users their
temporary passwords securely. Confirm they must change them on first sign-in.

On the hosted app, check admin and site-user sign-in, project isolation,
restricted actions, workbook preview/import, over-quantity approval, positive
over-budget display, page refreshes, live notifications, and persistence after
a backend restart. Test backup restoration before relying on the app.
The current app requires connectivity to load data and submit requests; it does
not support offline requests or offline workbook imports.

For local PostgreSQL verification, tests can use `ISTROM_TEST_POSTGRES_URL`.
This must point to a loopback host and a disposable database named
`istrom_test_*`. The fixture creates and drops its tables. Never use an
application database for tests.

## Budgets and Sessions

Budget reports use each item's planned quantity and planned unit cost. Current
stock and current prices can change without changing the plan. Inventory's Edit
dialog lets an admin adjust planned values separately.

On first upgrade, existing planned quantities are reconstructed from remaining
stock plus quantities in approved requests. Planned prices start from the saved
unit cost; historical price edits cannot be recovered automatically. Later
startups preserve the planned values.

Renaming a project site moves its linked records and assigned users together,
and ends their sessions. Deactivating a site blocks assigned users. Disabling,
reassigning or resetting a user ends that person's sessions
and removes their push subscriptions. Other users keep their access.
The account upgrade keeps sites, inventory, requests and Actuals. Historical
shared-code identities remain as historical records; new requests and approval
decisions save the username alongside the account ID. Users are disabled
rather than deleted, and the last active administrator cannot be removed.

Refreshing keeps the current page and the administrator's selected project.
Sign-ins are stored per tab, so signing in or out in one tab does not change
other tabs. Each tab remembers its own project for the signed-in account;
sign-out clears that tab's selection. Restored projects are checked against active sites.
Responses from a previous sign-in are discarded if the tab has switched accounts.
The update clears the previous shared login; existing tabs need to sign in once.
Password changes, account resets, and access revocations still invalidate all
affected sessions on the server.
Temporary connection failures show a retry button on the current page while
keeping the saved sign-in. Expired or revoked access still requires signing in.

Run checks with `.venv/bin/python -m pytest backend/tests`,
`npm run test --prefix frontend`, `npm run lint --prefix frontend`, and
`npm run build`. Backend route tests use an isolated database.

Workbook import detects unnamed unit columns even when a table contains unused
or unpriced lines. Broad materials headings allow trade groups such as Woods and
Irons to be inferred; explicit trade and labour headings are preserved. Review
these suggestions before saving. Item names and units can be corrected in the
preview, and missing units block import. Separate building scopes in one table
remain separate review budgets. Source total conflicts still require correction
or excluding the affected budget; the importer does not adjust costs to hide them.

## Project Structure

```
backend/
  api/
    main.py          # FastAPI app
    routes/          # API routes
    schemas.py       # Pydantic models
    dependencies.py  # Auth, DB
  db.py
  models.py
  schema_init.py
  constants.py

frontend/
  src/
    api.js          # API client
    contexts/       # Auth context
    components/    # Layout, etc.
    pages/         # Tab pages
```

## Request quantities and Actuals

Inventory and the dashboard show original quantities and costs, using the saved
planned values. Approval records usage and cost in Actuals and reduces the internal
available quantity. Actuals shows original quantity, recorded usage, and remaining
availability together. Admins can adjust current availability and price there;
updates reject stale quantity snapshots to avoid overwriting a concurrent approval.

Requests above remaining availability can be submitted for review. The request
form and review table show the requested amount, available amount, and shortfall
in red. Admins can approve the full requested quantity, including any excess.
Actuals records all usage and costs. It shows overspending as a positive red
"Over budget" amount, and excess quantities as a positive "Over quantity"
amount with zero available. CSV exports have separate remaining-budget and
over-budget columns. Request history preserves the quantity approved above availability,
even after stock arrives. Reversing an approval restores availability, clears
its over-quantity marker, and removes its linked actual cost record.
Building-block filters limit recorded usage and costs; remaining availability
always refers to the site's shared inventory item.

Approval rows show the project, building scope, estimated cost and building subtype.
Open Details for the requested unit price, section, note and decision time.
Approved history uses recorded Actuals costs, so later inventory price changes
do not change the displayed approved cost. Inventory filters include custom
sections from imported budgets. Item edits, imports, requests and approvals
reject overflowing cost totals before saving them.
Fractional approvals and reversals use decimal quantity arithmetic while holding
the inventory lock. Currency comparisons use rounded kobo amounts; a balanced
item displays "On budget". Simultaneous project changes share the account-change
lock so duplicate names and assignment changes cannot bypass validation.
Record writes lock their project before changing inventory or request records,
so a concurrent rename keeps new imports and existing history under the same
site. Project and user changes also refresh other open admin workspaces.
Reports include custom and unassigned building types, and totals and exports
use decimal sums.
Import previews and commits also use decimal totals, including the one-kobo
reconciliation tolerance. Incomplete Excel formulas require correction in the
preview instead of causing a server error.

Signing out removes only the current account's device notification registration.
The browser subscription remains available to other tabs. The Notifications
page checks whether the device is registered for the current account; enabling
device notifications switches that device to the account in that tab.
Device registration rechecks account access after concurrent account changes.
Delivery checks current account and project access, skips revoked accounts,
and removes their device registrations.

Only site users submit requests. Administrators review and approve them, and
the API enforces this separation. Notification read status belongs to each
individual user, including when several users share a project. Inventory edits,
imports, request reversals and deletions update connected project screens.
If the live connection drops, active views refresh every 30 seconds and refresh
again on reconnection. Changing the selected project resets page filters and forms.
Bulk inventory deletion reports every item it kept and the reason, including
items linked to requests or actuals. Inventory deletion is serialized with new
linked records so concurrent actions cannot leave missing item references.

## Security controls and deployment

The API validates roles, active project sites, credential versions, and token
expiry on protected requests. The frontend confirms the saved identity with
the server on reload and restricts import, entry, and settings routes by role.
WebSockets authenticate in a message and check browser origins. Individual
passwords use salted scrypt hashes (N=32768, r=8, p=3), following the
[OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
Passwords are never returned by the API or recorded in sign-in logs. New and
reset accounts must replace their temporary password before accessing records.
Login attempts are limited by both IP and username. Legacy administrator
sessions can reach only initial account setup; legacy site sessions are rejected.

Push delivery accepts browser vendor endpoints, disables redirects, and checks
subscription ownership. Uploads have body, file, ZIP expansion, and XML limits.
CSV exports protect text cells from formula execution. API responses disable
caching and set content-type, referrer, and frame protection headers.

Before deploying outside this computer, complete first-administrator setup,
use HTTPS, configure `CORS_ORIGINS` for the deployed frontend, and apply
frontend security headers at the hosting server. Login throttling is per process;
multiple workers need a shared limiter. The October 2026 review was local:
external dependency advisory audits were declined. Older backend dependency
pins still need updates and an advisory audit before production; this review
does not certify package vulnerability coverage or deployment security.

## Features

- **Individual Login** - A fixed admin account and individual site-user usernames, password changes and forced temporary-password replacement
- **User Management** - Create users, assign a project site, reset passwords and disable access
- **Manual Entry** - Add items with budget, section, building type
- **Inventory** - View, edit, delete items
- **Make Request** - Submit requests with approval workflow
- **Review & History** - Approve/reject, bulk actions, deleted logs
- **Budget Summary** - By building type and budget
- **Actuals** - Budget vs actual comparison
- **Admin Settings** - Project sites, user management links and sign-in logs
- **Notifications** - Approvals, rejections, submissions

## Importing Excel workbooks

Use **Import Workbook** with a project site and an `.xlsx` file. The importer
finds headings below title rows, accepts common names for columns, reads split
headers and columns in different orders, and follows repeated tables. Declared
merged cells preserve building, budget, group, section and unit metadata. It
checks every sheet, including `Sheet1` and
`Sheet2`. Older `.xls` files must first be saved as `.xlsx`.

Choose **Upload & preview** to see an editable table immediately. Select a
budget to review its rows, edit cells directly, and untick unwanted rows.
Search and **Only rows needing fixes** help locate corrections; larger budgets
show 50 rows per page. Building type, budget number, scope and quantity multiplier
are editable above the table. Amounts and selected totals update as you edit.
The final review checkbox confirms all selected budgets before import; editing
again clears that confirmation. Missing fields and total differences block import.

For unfamiliar headings, expand the sheet under **Column settings**. Choose
the header row and columns for item name with quantity and unit cost, or with a
line amount. Amount-only allowances use quantity 1; missing rates or quantities
can be derived from numeric amounts, with a warning for review. Optional
columns include unit, section, group, category, building type, and budget number.
Use header row **0** for data without headings. Exclude notes or summary sheets
that do not contain inventory, then choose **Apply column settings**.
This rebuilds the preview and resets any row corrections.

Review building types, budget numbers, groups, and categories. Blank, negative,
or unreadable quantities and prices stay empty and block import until corrected
or excluded. Unnamed cost rows remain editable rather than being discarded.
Currency prefixes/suffixes, grouped thousands and unambiguous decimal commas
are read as numbers; arbitrary text is never stripped to invent a value.
Simple arithmetic, percentages and SUM formulas without saved results are
calculated with bounded references. Unsupported, external or circular formulas
remain flagged; open and save the workbook in Excel, or enter the value in the
preview. Duplicate column meanings require manual mapping. A recognized earlier
table with incomplete headings blocks import so its costs are not omitted.
Source warnings remain available beside each item. Zero is a valid value.

Files can be up to 15 MB, with up to 50 sheets, 10,000 rows and 100 columns per
sheet. One import accepts at most 2,000 selected items. Previewing and remapping
do not write inventory; only the final **Import** button saves the selected rows.
