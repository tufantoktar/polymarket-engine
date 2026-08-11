# Archived scripts — DO NOT RUN

## push.sh.DANGEROUS

Quarantined 2026-08-11 (Phase 0).

This script was written for a *different* repository
(`tufantoktar/learning_git`) and is destructive if run from
polymarket-engine:

  - `git remote remove origin` then re-adds origin pointing at
    `learning_git` — silently detaching this repo from its real remote
  - `git push -f` (force) when the target branch is `main`/`master`

Running it from this repository would repoint `origin` away from
`polymarket-engine` and could force-overwrite a branch.

Normal delivery flow:

    npm run verify && git commit && git push origin feature/<name>

No agent or automation may execute this file.
