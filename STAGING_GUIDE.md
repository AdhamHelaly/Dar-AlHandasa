# Staging Guide

## Identity

- Staging project ref: `bmmrjbyxmzwrohuprrwa`.
- Production ref, never use for test writes: `ipegazjnkejasorskdur`.
- Staging API binds to `127.0.0.1:3203`; frontend development server uses `127.0.0.1:4200`.
- Keep `WHATSAPP_RESERVATION_WORKER_ENABLED=false` by default.

## Local credentials

Copy `.env.staging.example` to `.env.staging` and supply credentials for the dedicated Staging project only. Keep the file local; `.gitignore` excludes `.env.staging`. Never copy production credentials into it or print any values. The backend startup command clears inherited Supabase/admin environment variables before loading `.env.staging`.

## Startup and checks

From `A:\DarAlhandsa`:

```powershell
npm run start:api:staging
npm start -- --host 127.0.0.1
```

Open the local storefront with `?stagingTest=1` to opt into port `3203`. Normal browsing remains routed to the configured local review API. Confirm `/api/health` reports `environment=staging` and project ref `bmmrjbyxmzwrohuprrwa` before every test write. Refuse any mismatch.

Synthetic fixture: product `STAGE-20261121-672B643111`, ID `207f60a5-1525-43ce-a161-53f67449673f`, 1500 EGP, stock 12, published. Staging delivery is enabled with fee 0. Do not overwrite the fixture with imported or checkout data.

## WhatsApp reservation expiry

No expiry test has been completed. The migration hardcodes a 30-minute expiry. A real scheduled test requires the Staging worker to be explicitly enabled and the full interval to elapse; do not edit timestamps or invoke production RPCs. Before enabling, verify there are no unrelated pending reservations. Afterward stop/restart only the exact Staging process and verify worker disabled, unscheduled, and not running.
