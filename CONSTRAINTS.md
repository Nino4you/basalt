# Constraints

Overnight plugin compatibility, 2026-11-15. Existing AGENTS.md and SECURITY.md remain authoritative.

## Floor

- No new suppression comments, skipped/deleted tests, swallowed errors or placeholder APIs to make a plugin appear compatible.
- No secrets, personal vault data or downloaded third-party bundles in commits.
- Public repository: no private email addresses, personal data or identifying local paths in source, commit metadata, PRs, issues, logs or attachments. Use synthetic fixtures, relative paths and GitHub noreply metadata; review staged content before committing.
- Do not weaken security, storage validation, conflict detection, backup rules or this bar to obtain green results.
- Work locally on the overnight branch; no push, release, deployment or unsolicited global tooling changes.

## Acceptance and verification

- Target: all 100 original survey plugins enabled, exercised and disabled with zero runtime/console errors. Count download failures, missing results and timeouts as failures, not passes. Preserve the selected IDs and versions for comparisons.
- `node tools/plugin-survey/run.mjs` produces diagnostic reports, NOT a passing compatibility gate; inspect `report.json` and every plugin result. Do not mistake its successful exit or API-member presence for working behavior.
- Each nontrivial host fix has a reproducing test that fails before the fix, plus a real unchanged bundle check when available.
- Zero TypeScript errors (`npm run build`); all unit tests pass (`npm test`); existing core checks remain green (`cargo test --workspace --locked`, fmt, clippy).
- API contracts come from the official `obsidian.d.ts`, not fabricated success objects. Browser checks do not prove native/Android compatibility.

The autonomous run applies this floor without an interactive quality interview. Coverage/performance budgets are not invented or lowered.
