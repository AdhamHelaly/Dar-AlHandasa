# Dar Al Handasa Workspace Rules

- The only approved project workspace is `A:\DarAlhandsa`.
- Before every project task, check the current working directory. Proceed only when it is exactly `A:\DarAlhandsa`; otherwise stop and ask the user to open the correct folder.
- Do not modify, copy, run commands in, build, test, or install dependencies in the old project on `C:`.
- Do not create another copy of the project.
- Run all project commands, builds, tests, and installations from `A:\DarAlhandsa` only.
- Preserve `.env` in this project. Never display its contents or expose Supabase keys or other secrets.
- Preserve Supabase configuration securely.
- Never apply a migration to the production database without the user's explicit request for that migration.
- Do not overwrite or delete production data. Do not create production test records.
- Do not modify application code or production database records unless the user explicitly requests that work.

## External-agent scope

- Google Antigravity may work only inside `A:\DarAlhandsa` and must preserve existing uncommitted changes.
- Initial Antigravity work is limited to the brand filter, responsive design, storefront UX and product detail UI, cart and checkout presentation, admin dashboard UI, Excel import UI, frontend performance, and browser testing.
- Antigravity must not independently change database schema, SQL RPCs, production settings, or order business rules. Stop and prepare a reviewable proposal if one of those changes appears necessary.
- Never expose `.env`, `.env.staging`, API keys, service-role credentials, admin passwords, or session tokens in terminal output, browser screenshots, logs, documentation, or Git.
- Staging business-data tests must verify the exact Staging project ref `bmmrjbyxmzwrohuprrwa` and use the loopback Staging API on port `3203`. Never use production credentials or route test writes through ports `3000` or `3103`.
- Keep `WHATSAPP_RESERVATION_WORKER_ENABLED=false` except during a separately approved, isolated Staging expiry test. Never send real WhatsApp, email, or payment messages.
