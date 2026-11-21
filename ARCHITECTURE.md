# Architecture

## Stack and entry points

- **Frontend:** Angular 22 standalone application; primary state and storefront/admin workflows are in `src/app/app.ts`, with the rendered UI in `src/app/app.html` and shared styling in `src/styles.scss`.
- **Backend:** Node.js HTTP API in `server.mjs`. `npm run start:api` starts the ordinary API; `npm run start:api:staging` loads `.env.staging` exclusively and fails closed on an invalid or production Staging identity.
- **Data:** Supabase is the source of truth. Migrations are checked in under `supabase/migrations/`.
- **Images:** Product files use the `product-images` Storage bucket. Image URLs are stored on product rows and served through the public storefront.

## Request routing

The frontend uses `127.0.0.1:3000` by default in local development. At the exact development origin `http://127.0.0.1:4200`, `?stagingTest=1` selects the Staging API at `127.0.0.1:3203`. The separate read-only review guard remains at `127.0.0.1:3000`; the normal Node API upstream is at `127.0.0.1:3103`. Never use the latter two for test writes.

## Order data flow

The browser sends product IDs and quantities to `POST /api/orders`; the server calls `public.create_delivery_order`. That RPC locks products, reads current prices and stock, writes order and item snapshots, deducts stock and creates inventory movements in one transaction. A UUID idempotency key and request fingerprint protect retries. WhatsApp orders reserve stock for 30 minutes and return a prepared URL/message; do not open that URL during tests.

Admin status changes call `public.set_order_status`. Eligible cancellation restores stock and records a movement once. The expiry worker calls `public.expire_whatsapp_reservations` on a 60-second schedule only when explicitly enabled and allowed by the environment. Keep the Staging worker disabled by default.

## Admin authentication

Admin sign-in compares against `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the selected environment file. It does not use the `public.users` table. The API returns a signed Bearer token; Angular stores it in `localStorage` with an eight-hour expiry. The current logout handler removes the browser token but does not revoke it server-side; a copied token remains valid until expiry. No cookies are used for the admin session.

## Isolation and secrets

`.env` and `.env.staging` are ignored by Git. Staging processes must use only `.env.staging`, bind to `127.0.0.1:3203`, and report project ref `bmmrjbyxmzwrohuprrwa`. Do not expose service-role keys to Angular. Never write to production during tests.
