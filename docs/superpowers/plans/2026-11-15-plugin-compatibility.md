# Plugin compatibility implementation plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. The user explicitly requested autonomous overnight execution, so no approval questions or subagents are required.

**Goal:** all 100 unmodified community plugin bundles complete the existing survey lifecycle without errors.

**Architecture:** fix shared compatibility contracts in `src/compat/`, using existing browser, CodeMirror and capability-scoped vault implementations. Reproduce actual bundle failures before implementation; keep system-access failures honest rather than granting ambient Node/Electron privileges.

**Tech stack:** TypeScript, Vitest/jsdom, Playwright Chromium, existing Rust/Tauri storage.

**Spec:** user overnight request; `CONSTRAINTS.md`; `.opencode/overnight-log.md` records assumptions and current queue.

## Global constraints

- No push/deploy/release, no real vault data, no suppressed errors/skips/fake success APIs.
- Preserve shared host classes/CodeMirror instances and storage/security boundaries.
- Original reports are pre-three-PR evidence, not the new baseline.

## Review focus

- Null active file: host reports null truthfully; test an actual valid note lifecycle separately.
- Async plugin activation/unload: cleanup must still run once and failures remain visible.
- Host registrations: commands, handlers and UI must unregister when a plugin unloads.
- Malformed/untrusted bundle paths: no ambient filesystem/process access or broader resource grants.
- Partial survey runs: exactly 100 distinct selected plugins, download failures/timeouts/errors counted.

## Task 1: establish comparable survey evidence

Files: existing `tools/plugin-survey/run.mjs`, `tests/e2e/plugin-survey.spec.ts`; cache artifacts stay untracked.

- [x] Run post-PR baseline, inspect report and individual result errors (not runner exit alone).
- [x] Preserve selected IDs, versions, checksums and raw baseline before any focused rerun overwrites results.
- [ ] Rank genuine host gaps; distinguish unsupported system capabilities and fixture defects.

## Task 2+: one shared gap per verified local commit

Files depend on reproduced gap: existing compat owner and matching `tests/unit/*`; no broad refactor.

- [ ] Read official API signature and all callers of the touched function.
- [ ] Add named regression test exercising the missing contract, run focused `npm test -- <file>` and confirm RED.
- [ ] Implement the smallest real contract in its current owner, preserving cleanup/validation.
- [ ] Run the regression and related unit tests to GREEN, then `npm run build`.
- [ ] Run unchanged affected release bundles through the survey; retain failure details.
- [ ] Review diff against CONSTRAINTS and commit only verified scope; update overnight log.

## Final repeated milestone

- [ ] Run all 100 fixed-version bundles and separately count zero-error results and failures.
- [ ] Run full unit/build/browser/core checks after relevant changes.
- [ ] Log exact evidence and remaining limitations, then continue with the next task serving the original target.
