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
