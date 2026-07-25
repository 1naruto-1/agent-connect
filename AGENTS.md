# AGENTS.md

## Purpose

agent-connect migrates one persisted coding-agent session at a time between Cursor, Claude Code, Codex CLI, and Pi. It is a zero-runtime-dependency ESM CLI that requires Node.js 23.4 or later because Cursor integration uses `node:sqlite`.

## Repository map

| Path | Responsibility |
| --- | --- |
| `bin/agent-connect.js` | CLI entry point, Node-version gate, and command routing |
| `src/commands/` | Interactive, list, direct-migration, and command-install handlers |
| `src/adapters/` | One native session reader/writer adapter per supported tool |
| `src/adapters/index.js` | Adapter registry |
| `src/events.js` | Canonical event vocabulary, migration statistics, and report rendering |
| `src/migrate.js` | Read → normalize → provenance marker → write orchestration |
| `src/cursor.js` / `src/cursor-writer.js` | Cursor SQLite access and legacy composer serialization |
| `commands/` | Claude Code slash-command prompts; not session-format templates |
| `docs/architecture.md` | Architecture, storage, adapter contract, and maintenance guide |
| `README.md` | Default English user documentation |
| `README.zh.md` | Simplified Chinese user documentation |

## Architecture rules

- Preserve the adapter boundary. Tool-specific parsing, storage paths, and native record shapes belong in the corresponding module under `src/adapters/` (or the dedicated Cursor helpers), never in `src/migrate.js`.
- The interchange format is an ordered canonical event stream: `user`, `assistant-text`, `thinking`, `tool`, and `marker`. Preserve event order, timestamps, tool input, output, and error state whenever the source exposes them.
- Keep tool mappings explicit. Unsupported target tools must retain their arguments and result as a readable record rather than being silently dropped.
- Every adapter needs `id`, `label`, `available()`, `listSessions()`, `readSession()`, `writeReady()`, `writeSession()`, and target-specific `writeNotes` where needed. Register completed adapters only in `src/adapters/index.js`.
- A migration writes a new target session; it must not modify the source session. Do not add hidden batch behavior or deduplication without documenting it in the CLI and architecture guide.

## Code style

- Use native ESM, two-space indentation, semicolons, single-quoted strings, and `camelCase` identifiers. Use `UPPER_SNAKE_CASE` only for constants.
- Use lowercase kebab-case filenames for multiword files, such as `cursor-writer.js`.
- Keep comments and CLI output concise. Follow the existing language of the surrounding user-facing text.
- Do not introduce runtime dependencies unless the benefit justifies losing the current zero-dependency design.

## Documentation

- `README.md` is the default English entry point; link its Chinese counterpart as `README.zh.md`.
- Keep user-facing behavioral changes synchronized in both root READMEs.
- Update `docs/architecture.md` when changing the canonical event model, an adapter contract, a storage layout, or the command flow.
- Keep generated reports and captured sessions out of documentation and Git history.

## Validation

There is no build step or automated test runner yet. Before committing, run the checks relevant to the change:

```bash
node bin/agent-connect.js --help
node bin/agent-connect.js list --json
npm pack --dry-run
git diff --check
```

For adapter changes, use disposable session data and cover session discovery, reading, writing, and unavailable-tool behavior. Never test destructive behavior against valuable live sessions. Cursor must be completely closed, including its tray process, before any write test.

## Security and generated data

Native sessions can contain prompts, file contents, terminal output, tokens, and credentials. `.agent-connect/` reports and `node_modules/` are ignored; do not force-add them. Redact examples, issues, fixtures, and logs before committing.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit:

```text
<type>(<optional scope>): <imperative summary>
```

Use one of `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, or `chore`. Choose a narrow scope when it improves clarity, for example `feat(adapters)`, `fix(cursor)`, or `docs(architecture)`. Keep the summary concise, imperative, and without a trailing period. Mark breaking changes with `!` after the type or scope and explain them in a `BREAKING CHANGE:` footer.

Examples:

```text
feat(adapters): add a native session reader
fix(cursor): preserve rejected terminal calls
docs(architecture): document adapter lifecycle
chore: normalize repository metadata
```

Keep each commit focused and include verification in the pull request description. For migration behavior changes, name the source and target tools, include safe sample output, and link the relevant issue when one exists.
