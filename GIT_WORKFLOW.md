# Git Workflow

- Approved root: `A:\DarAlhandsa`; branch `main` is based on `ef95d3329a45dc70d3b1352efd12a2f70074d101`.
- The approved GitHub remote is `https://github.com/AdhamHelaly/Dar-AlHandasa.git`. Never expose credentials embedded in remote configuration.
- Preserve existing work. Do not reset, revert, stash, amend, force-push, rewrite history, or merge to `main` without review.
- `.env`, `.env.staging`, `node_modules`, `dist`, local runtime files, and `supabase/.temp` are ignored. Do not force-add them.
- Before staging, inspect `git status`, complete diffs, filenames, and ignored files. Run relevant tests and `git diff --check`.
- For a completed validation/documentation change, create a new feature branch from the reviewed stable baseline, commit only intended source/docs/tests, then push that branch without force. Do not push while required validation remains incomplete.
- Current local changes include the existing `src/app/app.ts` Staging route switch, the Staging test runner safety update, and this handover documentation. No commit or push was made by this validation task.
