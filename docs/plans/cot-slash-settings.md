# COT slash commands, baseline filters, and settings

## Goal
Ship discoverable `/cot status` and `/cot settings` commands, first-run deterministic command-family filters, bounded inline previews, and clear adaptive-learning status while retaining privacy opt-in and raw-output recovery.

## Non-goals
- No live model requests during implementation or verification; background adaptive generation remains available only after explicit opt-in.
- No external service/config changes.
- No project-scoped settings; all settings are global beside the existing COT vault.
- No custom regex filter generation or destructive profile management in the menu.
- No command rewriting/execution sandbox or batch executor; COT remains a post-tool result hook.

## Context and research
- Work is on `feat/cot-slash-settings`, based on merged `origin/main` at `09cea72`; preserve the existing uncommitted settings draft.
- Installed extension commit `09cea72` only enables adaptive generation with `PI_COT_AUTO_PROFILE=1`. Visible Bun process environments had it unset.
- Local vault metadata: 0 saved/auto profiles, 118 outputs over 8 KiB in the last 24 hours, 3 same-session/target groups with at least 3 such outputs. No raw output bodies were inspected.
- Auto-generation additionally requires an available model and registry; it uses 3 unmatched large samples per session/target and a 1h cooldown. Before this work there was no status/attempt telemetry.
- README config exposed retention days, warning bytes, normal/codemode limits and auto opt-in. Settings must expose each implemented control plus model selection and built-in enablement.
- Reference patterns:
  - [LeanCTX](https://github.com/yvgude/lean-ctx): the `rust/src/core/patterns/` source tree includes broad CLI families (cloud, build/test, security, file/search and language tooling), alongside deterministic shell-output patterns, density/read modes and recoverable references.
  - [RTK](https://github.com/rtk-ai/rtk) and its [coverage table](https://www.rtk-ai.app/docs/resources/what-rtk-covers/): 100+ command coverage across Git/GitHub/Graphite, language toolchains, file/search, containers and infrastructure; the public table names common operation prefixes.
  - [Context Mode](https://github.com/mksglu/context-mode): explicit `ctx_batch_execute`, `ctx_execute`, `ctx_execute_file`, index/search/fetch and stats/doctor tools. COT adopts concise-first; its own output handles provide recovery. Context Mode's execution sandbox and batching remain separate features, while the generic preview covers oversized output from any tool.
- COT uses Pi's `ctx.ui.select`, `input`, `confirm` and `notify`; its data remains global in `~/.local/share/pi/COT/vault.sqlite`.

## Blast radius
- `extensions/cot.ts`: settings persistence, live config, slash commands, generation telemetry, storage warning, fallback preview and profile matching.
- `extensions/profiles.ts`: built-in command-family filters.
- `tests/cot.test.ts`, `tests/profile.test.ts`: settings/status, built-in filtering, bounded preview and no-live-model-call checks.
- `README.md`: user-facing commands, defaults and filter coverage.
- `dist/cot.js`: regenerate committed bundle.

## Steps
1. Persist all global settings additively in SQLite: adaptive learning, model choice, built-in toggle, normal/codemode inline-preview limits, retention days and storage warning bytes. Retention reductions require confirmation and apply existing output-pruning semantics.
2. Register `/cot status` and `/cot settings`. Status reports enabled state, effective model, built-in/saved/learned counts, eligible groups, in-flight generation and last sanitized outcome. Settings exposes every runtime knob; session model is the default, and unavailable fixed models fall back to session.
3. Ship 100+ deterministic command-prefix built-ins derived from LeanCTX pattern families and RTK's documented command list, including Git/GitHub/Graphite, file/search, language/build/test, cloud/container/deploy/security, and common runtimes. Use deterministic head/tail line truncation with diagnostic/log outputs favoring the tail and listings favoring the head; do not imply semantic equivalence to upstream formatters. Normalize leading `cd` and environment assignments so ordinary shell invocations still match. Most-specific selector wins; saved filters win specificity ties.
4. For oversized unmatched results, return a bounded head/tail preview inline (2,048 chars default; codemode 2,000) and preserve the raw output handle. This avoids the immediate extra `cot_get`/`cot_filter` call without hiding recovery.
5. Persist only sanitized generation states/timestamps; never sample text or provider errors. Built-in matches still permit opt-in adaptive generation so profiles may improve on the baseline.
6. Document actual behavior, privacy, settings precedence, status, and covered families; regenerate the committed bundle.

## Verification
- `bun test`
- `bun run build`
- `git diff --check`
- Confirm status output includes only counts/states/settings, no raw samples or provider errors.

## Rollback
Revert only this feature's commands/settings/filter changes and regenerated `dist/cot.js`. Keep vault outputs and user-saved filters untouched.

## Open questions
None.

### For Executor
Read order:
This plan, `extensions/cot.ts`, `extensions/profiles.ts`, both test files, README.
Assumed working state:
Preserve the current uncommitted changes on `feat/cot-slash-settings`.
Owned files:
`extensions/cot.ts`, `extensions/profiles.ts`, `tests/cot.test.ts`, `tests/profile.test.ts`, `README.md`, `dist/cot.js`, this plan.
Verification commands:
`bun test`, `bun run build`, `git diff --check`.
