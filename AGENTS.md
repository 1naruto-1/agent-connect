# AGENTS.md

## Purpose

Agent Connect migrates one persisted coding-agent session at a time between Cursor, Claude Code, Codex CLI, and Pi. Development uses Bun 1.3.14+ and TypeScript; releases are standalone Bun binaries, so end users do not need Bun or Node.js installed.

## Architecture rules

- Preserve the adapter boundary. Tool-specific parsing, storage paths, and native record shapes belong in the corresponding module under `src/adapters/` (or the dedicated Cursor helpers), never in `src/migrate.ts`.
- The interchange format is an ordered canonical event stream: `user`, `assistant-text`, `thinking`, `tool`, and `marker`. Preserve event order, timestamps, tool input, output, and error state whenever the source exposes them.
- Keep tool mappings explicit. Unsupported target tools must retain their arguments and result as a readable record rather than being silently dropped.
- Every adapter needs `id`, `label`, `available()`, `listSessions()`, `readSession()`, `writeReady()`, `writeSession()`, and target-specific `writeNotes` where needed. Register completed adapters only in `src/adapters/index.ts`.
- A migration writes a new target session; it must not modify the source session. Do not add hidden batch behavior or deduplication without documenting it in the CLI and architecture guide.

## Code style

- Use TypeScript, native ESM, two-space indentation, semicolons, single-quoted strings, and `camelCase` identifiers. Use `UPPER_SNAKE_CASE` only for constants.
- Use lowercase kebab-case filenames for multiword files, such as `cursor-writer.ts`.
- Keep TypeScript strict. Native Harness payloads may be opaque at adapter boundaries; do not expand existing `@ts-nocheck` compatibility islands—replace them with validated fixture-backed types as native formats are characterized.
- Keep comments and CLI output concise. Follow the existing language of the surrounding user-facing text.
- Do not introduce runtime dependencies unless they improve on Bun's built-in capabilities.

## Documentation

- `README.md` is the default English entry point; link its Chinese counterpart as `README.zh.md`.
- Keep user-facing behavioral changes synchronized in both root READMEs.
- Update `docs/architecture.md`, `docs/development-environment.md`, `docs/development.md`, or `docs/distribution.md` when their subject changes.
- Keep generated reports and captured sessions out of documentation and Git history.

## Validation

Bun 1.3.14+ is required for development. Before committing, run the checks relevant to the change:

```bash
bun install --frozen-lockfile
bun run check
bun run src/cli.ts --help
bun run build
bun run smoke:build
bun run verify:checksums
git diff --check
git diff --cached --check
```

For adapter changes, use disposable session data and cover session discovery, reading, writing, and unavailable-tool behavior. Never test destructive behavior against valuable live sessions. Cursor must be completely closed, including its tray process, before any write test.

## Security and generated data

Native sessions can contain prompts, file contents, terminal output, tokens, and credentials. `node_modules/`, `dist/`, coverage output, centrally stored reports, and test fixtures with unredacted session content must never be committed. Redact examples, issues, fixtures, and logs before committing.

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

## Releases

- Follow `docs/distribution.md`; do not infer the release process from an old command or move an existing release tag.
- `package.json.version` is the sole version source, and a release tag must match it exactly as `v<version>`.
- Push the release commit to `main` and wait for the full CI matrix before creating the annotated or signed tag.
- Never commit `dist/`; the tag workflow rebuilds, verifies, attests, and publishes all release assets.
