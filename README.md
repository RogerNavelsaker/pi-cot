# COT — Codemode Output Trimmer

COT is a Pi package for storing tool output, retrieving it by handle, and applying declarative filters. Its long-term goal is **adaptive output shaping**: the model learns which parts of command output matter, creates and refines reusable filters from experience, and uses a handle when it needs to inspect the original.

COT is inspired by ideas in RTK, Lean-CTX, and Context-Mode. Unlike a package that starts with a static catalog of curated command filters, COT is intended to grow its filter library through actual use. The initial library is empty; prebaked filters can be added after trial and evaluation.

## Install

Current Pi package syntax for a GitHub-hosted package:

```sh
pi install git:github.com/RogerNavelsaker/pi-cot
```

For a temporary trial:

```sh
pi -e git:github.com/RogerNavelsaker/pi-cot
```

The GitHub repository must exist before these commands work. Pi's documented Git package prefix is `git:github.com/…`.

## Current capabilities

- Stores textual tool results in SQLite and returns a handle when output exceeds its inline threshold.
- Retrieves stored output by handle, with pagination and optional session scoping.
- Applies declarative lines, contains, regex, json-path, and truncate filters, individually or as ordered pipelines; each step consumes the previous step’s output.
- Saves, replaces, lists, applies, and deletes reusable filters; optional selectors can apply profiles automatically to matching tool calls.
- Lists sessions; lists and searches outputs by session. Cross-session search requires explicit `all_sessions: true`.
- Expires output at startup (30 days by default), reports storage size warnings, supports dry-run-first pruning, and creates explicit SQLite backups.

### Typical model workflow

1. Inspect an unfamiliar command's output and identify the useful signal.
2. Use `cot_filter` to extract only that signal while retaining the original handle.
3. If the pattern is reusable, save a small declarative filter with `cot_save_filter`.
4. Reapply the saved filter when similar output appears; retrieve the raw handle with `cot_get` when more detail is needed.

Profiles without a selector remain available for explicit cot_filter use. A saved profile with a selector is applied automatically to matching tool results; the original output remains stored and the result includes a handle for recovery.

### Adaptive profile learning (opt-in)

Automatic learning is off by default. Set PI_COT_AUTO_PROFILE=1 to allow COT to ask the currently active Pi model for a profile after it sees at least three unmatched outputs of 8,192 characters or more from the same tool/command family in one session within 24 hours. The background request receives up to three unchanged 4,096-character excerpts; they may contain secrets. The model does not receive the full tool arguments. Enabling this setting explicitly opts into sending these excerpts to the active model; rely on the session model or an external proxy/MCP for protection. A candidate must use the bounded declarative filter DSL (generated regex filters are disabled), pass model validation, preserve non-empty examples, and reduce the stored examples by at least 20% before COT saves it.

Eligible output excerpts are sent unchanged to the active model provider and may contain sensitive data. Keep learning disabled unless you explicitly accept this; protection must come from the session model or an external proxy/MCP. Originals stay local in COT storage and remain retrievable by handle.

Manual profiles can target a tool and, for shell tools, a command family. For example, save a contains filter with selector { "toolName": "bash", "commandPrefix": "git status" } to apply it to git status calls but not unrelated shell commands. Exact top-level input fields can also be used in a selector.

## Tools

- `cot_vault`: `status`, `sessions`, session-scoped `list`/`search`, explicit cross-session search, dry-run-first `prune`, and `export`.
- `cot_capture`: store text and return a handle.
- `cot_get`: retrieve or page through a handle.
- `cot_filter`: list saved filters or filter a handle.
- `cot_save_filter`: create/update a reusable declarative filter.

## Configuration

COT requires a Pi runtime that supports Bun's `bun:sqlite` module.

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `PI_COT_RETENTION_DAYS` | `30` | Startup retention, integer from 1 to 36500 |
| `PI_COT_WARN_BYTES` | `104857600` | Storage warning threshold (100 MiB) |
| `PI_COT_THRESHOLD` | `0` | Inline character threshold for ordinary tool results |
| `PI_COT_CODEMODE_THRESHOLD` | `2000` | Inline character threshold for codemode output |
| `PI_COT_AUTO_PROFILE` | off | Set to 1 to opt into background profile generation using the active model |

The database lives at `~/.local/share/pi/COT/vault.sqlite`. Exported backups are created beside it. Review the source before installing: Pi extensions run with the agent's full permissions.

## Development

Use Bun:

```sh
bun test
bun run build
```

The package declares typebox and @earendil-works/pi-ai as peer dependencies provided by Pi. No compatibility tool aliases are provided.

## License

MIT. See [LICENSE](LICENSE).

## Filter pipelines

A saved pipeline composes existing filter specs in order; it does not execute generated code. Example: {"steps":[{"type":"contains","query":"error"},{"type":"lines","start":1,"end":20}]}. Retrieve the original output with cot_get at any time. Delete a saved filter by name with cot_delete_filter.
