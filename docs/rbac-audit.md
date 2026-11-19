# RBAC review — 2026-11-19

There are four business roles. Public browsing is anonymous access, not a fifth role.

| Business role | Code / app mode | Local URL | Existing pages or sections |
| --- | --- | --- | --- |
| Admin | `PLATFORM_ADMIN` / `admin` | http://127.0.0.1:5174 | Login, overview, stores, employees, access, reports, settings, support |
| Shop | `STORE_ADMIN` / `store` | http://127.0.0.1:5175 | Login/register, overview, orders/dispatch, products, reports, settings, subscription/payment |
| Employee | `DELIVERY_EMPLOYEE` / `courier` | http://127.0.0.1:5176 | Login/register/verification, home/jobs, deliveries, wallet, profile |
| User | `CUSTOMER` / `public` | http://127.0.0.1:5173 | Login/register, market, checkout, order history, profile/tracking |

The public app at http://127.0.0.1:5173 contains customer registration/login,
market browsing, checkout, order history and customer profile flows.
There is no separate customer frontend or customer deployment. The customer backend service
and `CUSTOMER` authorization remain part of the system.
Most portal sections switch component state rather than having separate browser URLs.

## Corrections

- Store, employee and customer protected HTTP routes now check the signed role,
  not only the presence of a user ID. Store routes also require a signed tenant.
- Development identity headers are disabled in production, even if the development flag is enabled.
- Store dispatch no longer falls back to orders from other tenants or silently selects
  a different order when an explicit order ID is inaccessible.
- Notification reads and mark-as-read operations are restricted to the signed user or store tenant.
  Internal events without an identifiable recipient do not become global business notifications.
  Legacy unaddressed notifications are intentionally hidden from non-admin accounts.
- Public realtime connections send refresh signals only; business payloads, locations and identities
  are retrieved through authenticated HTTP APIs.
- Customer payment checks verify invoice ownership; provider callbacks still verify payment
  with QPay and return only an acknowledgement.
- Removed the redundant standalone customer portal, development server, and build target.
  Customer login and workflows use the existing public client.
- Gateway failures no longer return a fabricated successful employee dashboard.

## Remaining product gaps

- Separate sections do not imply that every feature is finished. Admin reports/settings/support
  still use the generic section renderer. These need product implementation, not additional roles.
- Prisma still contains the legacy `SHOP_ADMIN` enum and the admin employee editor offers it.
  Store authentication currently uses `STORE_ADMIN`. Existing legacy accounts should be inventoried
  before migrating/removing that value; no database migration was performed in this review.
- Database role/permission tables exist, but HTTP authorization currently uses role checks and
  resource ownership, not a general permission-code enforcement layer.
- Creating a store-role user from the admin employee editor does not create a store tenant
  membership; store login requires that membership. Use the store registration flow until
  the employee editor can explicitly assign a store.
- Store/customer JWTs are stateless. Immediate token revocation when an account is suspended
  requires an additional account/session check; the role guard alone does not provide it.
- Full real-account login, payment, tenant-to-tenant data access and delivery workflows still need
  end-to-end checks against a configured test database. This review does not claim they all work.

## Validation

`npm run test:rbac` exercises every protected store/courier/customer HTTP route with anonymous
requests and wrong-role JWTs, correct-role middleware, expired/invalid tokens, missing store tenant,
production development-header rejection, anonymous admin management requests, notification audience
filters and realtime payload redaction. It uses isolated HTTP servers and synthetic identities,
with no real database writes.

Build all portal entries with `npm run build:all --workspace client`.
In a restricted environment where Vite's config bundler cannot read parent directories,
run TypeScript first, then invoke Vite for each mode with `--configLoader runner`.
Run `npm run build:server` for server syntax validation.
