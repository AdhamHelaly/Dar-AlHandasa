# Dar Al Handasa — Project Handover

## Project

Dar Al Handasa is an Arabic, RTL-first storefront built with Angular 22, a Node.js API, and Supabase. The approved workspace is `A:\DarAlhandsa`. The production project is `ipegazjnkejasorskdur`; isolated Staging is `bmmrjbyxmzwrohuprrwa`.

## Current verified state — 2026-11-21

- Stable Git baseline: `ef95d3329a45dc70d3b1352efd12a2f70074d101`, branch `main`; GitHub `main` matched that hash at the last read-only check.
- The Angular source has an existing uncommitted local-only Staging route switch in `src/app/app.ts`. `scripts/staging-order-tests.mjs` was updated during the E2E preparation to pin all tests to port `3203` and verify Staging identity before each order/status write.
- Staging API health returned `ok` for the expected ref. The WhatsApp expiry worker is disabled, unscheduled, and not running.
- The local admin sign-in succeeded using Staging-only environment credentials. The admin product list showed `STAGE-20261121-672B643111` at 1500 EGP, stock 12, published.
- API checkout validation passed for server-calculated price, same-key replay, same-key conflict, overstock, unavailable product, invalid delivery data, concurrent submissions, WhatsApp reservation creation/message preparation, and cancellation restoration.
- The test restored the Staging fixture stock to 12. Three test orders remain as cancelled audit records and six matching test inventory movements remain. No safe application-level order-delete route exists; exact IDs are recorded in `TESTING_GUIDE.md`.
- Production product `TCBNLI500857` was read before and after the Staging tests: 7000 EGP, stock 3, published, image present. No production writes were made.
- The reservation expiry test was not run because the actual database expiry is 30 minutes and no deterministic safe clock/test hook exists. The worker remains disabled.
- The browser-control runtime stopped during the requested reload check. Login and catalog rendering were observed, but session persistence after reload and UI logout were not verified in this run.
- The Angular production build succeeds, with the initial bundle above its 520 kB warning budget. Existing Node tests pass; see `TESTING_GUIDE.md`.

## Remaining work

1. Finish browser checkout and admin order workflows against Staging only, then verify reload persistence and client logout in the browser.
2. Decide whether to wait the full 30 minutes for scheduled WhatsApp expiry. Do not shorten or edit the reservation timestamp to simulate it.
3. Exercise Excel preview and a successful import only after a safe exact cleanup path for imported products is reviewed. The current admin delete operation archives products; it does not permanently remove them.
4. Review the remaining cancelled test order artifacts and decide whether retaining audit history is preferred. Do not delete them without a reviewed, exact-scope cleanup plan.
5. Review the complete Git diff, commit the finished handover on a feature branch, and push only after the remaining required checks pass. Do not merge into `main` without review.

## Antigravity initial scope

Start with the storefront brand filter and responsive layout. Then review the product detail and cart/checkout presentation, admin UI, Excel import preview UX, and frontend performance. Use browser tests with the Staging route switch. Do not change SQL, schema, RPC behavior, production settings, or order business rules independently.
