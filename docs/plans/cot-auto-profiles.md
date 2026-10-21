# COT automatic tool profiles

## Goal
Apply saved declarative profiles automatically to matching tool results, and asynchronously generate, validate, and activate a profile after repeated large unmatched output while retaining every original output for recovery.

## Non-goals
- No generated executable code, shell commands, or arbitrary model-produced functions.
- No static catalog of built-in command formatters in this change; README describes the initial library as empty, and this keeps that policy.
- No retroactive rewriting of prior tool results.
- No live/model-backed calls during development tests, and no change to configured providers or remote services.

## Context and decisions
- extensions/cot.ts stores raw textual results in SQLite and applies saved filters only through explicit cot_filter calls.
- Pi's tool_result event supplies toolName, input, content, and supports partial result patches. The installed Pi API exposes ctx.model, ctx.modelRegistry.getApiKeyAndHeaders(), and completeSimple() from @earendil-works/pi-ai.
- Existing profiles use the declarative lines, contains, regex, json-path, and pipeline DSL. Add only a safe truncate operation (head/tail lines with an omission marker) for compression. Generated profiles do not use regex, avoiding untrusted model-generated regular expressions.
- A selector has toolName, optional commandPrefix, and optional exact top-level input constraints. Shell selectors match a command family at the start of the command, not merely toolName: bash.
- Learning defaults: 3 eligible outputs of at least 8,192 characters, from the same tool/command family and current session within 24 hours. One in-flight attempt per target/session; failures stay quiet and are retried after a cooldown.
- The background request uses the currently active Pi model. It receives up to three 4,096-character examples unchanged, and may contain secrets; only the target family, not full call arguments or paths, accompanies them. PI_COT_AUTO_PROFILE=1 opts into generation; generation is off by default. The opt-in disclosure must state excerpts are unchanged and may contain secrets; protection must come from the session model or an external proxy/MCP.
- Activation requires the model's explicit validation pass, a valid bounded DSL profile, and local replay against full stored examples: no non-empty example may become empty and aggregate output must shrink by at least 20%. Originals remain stored and the handle remains available.
- Keep learning session-scoped to avoid mixing unrelated content; profiles themselves remain available across sessions.

## Blast radius
- extensions/cot.ts: additive SQLite migrations, selector validation/matching, automatic dispatch, asynchronous suggestion/validation, and compatible tool schemas.
- tests/cot.test.ts plus focused profile tests: selector matching, migration/backward compatibility, truncate semantics, auto-apply, learning gates, validation, and raw recovery.
- package.json: declare Pi's bundled @earendil-works/pi-ai as a peer and externalize it from the build.
- README.md: document selectors, learning thresholds, active-model use, opt-out, unchanged samples and their secret risk, and retained raw outputs.

## Steps
1. Add failing tests for selector matching, target-family extraction, truncate, candidate validation, and automatic profile dispatch. Verify the focused tests fail for the intended missing behavior.
2. Implement pure profile/selector helpers and bounded DSL validation. Verify the focused tests pass.
3. Add additive SQLite migrations for nullable selectors and output target keys; extend cot_save_filter and filter listing without changing existing filters. Verify legacy-filter tests and migration tests pass.
4. Wire automatic matching into tool_result, applying only the selected profile to the model-facing result while preserving raw output and handle recovery. Verify integration tests.
5. Add same-session repeated-output detection and a non-blocking completeSimple() job using the active Pi model. Parse strict JSON, replay and validate candidates locally, then auto-save only passing profiles. Tests inject a fake generator; never call a real model in tests.
6. Update README and package metadata/build externalization. Verify package build and docs.
7. Review the full diff and run the complete test suite.

## Verification
- Focused tests: bun test tests/profile.test.ts tests/cot.test.ts
- Full tests: bun test
- Build: bun run build
- Diff hygiene: git diff --check and inspect git diff

## Rollback
Revert this feature branch. Database changes are additive (ALTER TABLE columns); existing outputs and filters remain usable. Do not delete or rewrite stored raw outputs.

## Open questions
None blocking. The thresholds above are initial defaults; learning is off unless explicitly enabled, and enabled requests send unchanged excerpts that may contain secrets.
