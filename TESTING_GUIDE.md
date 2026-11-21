# Testing Guide

Run project commands only from `A:\DarAlhandsa`. Never run order, inventory, image, or import tests against production.

## Local automated tests

```powershell
node --check server.mjs
node --check scripts/staging-order-tests.mjs
node scripts/storefront-logic.test.mjs
node scripts/product-image-safety.test.mjs
$env:NODE_OPTIONS='--max-old-space-size=4096'
npm run build -- --configuration production
```

`npm test` currently fails because the Angular CLI has no `test` target in `angular.json` and there are no `*.spec.*` files. The focused Node suites are the current automated checks. Production build warns that initial JS/CSS total is 603.98 kB against a 520 kB warning budget; the build succeeds and the XLSX chunk is lazy-loaded.

## Staging checkout API suite

Only run after checking `http://127.0.0.1:3203/api/health`, the Node process argument `--env=staging`, and the expected ref `bmmrjbyxmzwrohuprrwa`.

```powershell
node scripts/staging-order-tests.mjs --suite=checkout --confirm-staging-writes
```

The script is pinned to `http://127.0.0.1:3203/api`, rechecks Staging health before every order/status write, checks the fixture identity/value, never retries an ambiguous order submission, and attempts to cancel its exact pending orders. It does not call the expiry RPC or open WhatsApp URLs.

## 2026-11-21 Staging run

- Storefront logic: 9 passed, 0 failed.
- Product image safety: 87 passed, 0 failed.
- Staging checkout API suite: all assertions passed. Invalid overstock, unavailable-product, and missing-address requests were rejected without stock or movement changes. Price came from the database, retries were idempotent, concurrent orders did not oversell, and cancellation restored stock once.
- The test prepared a synthetic WhatsApp message and reservation, but did not open WhatsApp or send a message.
- Test order IDs, all cancelled: `de2cd278-9c17-40e9-8f01-1603cb373b58`, `a2293cff-da49-4e87-b890-57d50f102fec`, `d5563174-5dd8-499e-b487-f25dd2b4a576`.
- Read-only baseline file (local and ignored): `supabase/.temp/staging-e2e-baseline-20261121-185521.json`.
- Fixture stock returned to 12. Six test inventory movement rows remain as audit history; there were no pending WhatsApp reservations. No permanent order-delete route is implemented, so these exact cancelled test records were retained.
- Expiration and browser checkout were not tested. The reservation's actual 30-minute expiry requires a full wait; no clock adjustment or SQL timestamp edit is permitted for simulation.
- Browser admin sign-in and the catalog were observed in a previous step, but the browser automation controller failed during reload verification; do not claim persistence/logout verification.

## Excel import

The UI parses the first worksheet, recognizes the aliases in `src/app/app.ts`, checks required SKU/name/category/price/stock fields, and reports duplicate SKUs. The API processes rows sequentially and returns row-level errors and partial-success counts. On 2026-11-21 a Staging-only invalid/duplicate request returned 0 created and 4 failed rows; product count remained 1 and category/brand counts were unchanged.

Valid import, mixed partial-success behavior, import UI preview, and imported-product cleanup are not yet tested. Do not import a valid product until exact cleanup is reviewed: current admin deletion archives products rather than permanently deleting them.
