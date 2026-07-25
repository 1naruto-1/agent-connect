# Development workflow

[Development environment](development-environment.md) · [Architecture](architecture.md) · [Distribution](distribution.md)

## Source layout

```text
src/cli.ts                 Bun CLI entry point
src/events.ts              Canonical event model and migration report rendering
src/migrate.ts             Source read → target write orchestration
src/platform/paths.ts      Per-platform data/report/executable path resolution
src/adapters/              Native Cursor, Claude Code, Codex CLI, and Pi adapters
src/cursor*.ts             Cursor SQLite helpers and legacy writer
commands/                  Claude Code command templates embedded into binaries
scripts/build.ts           Standalone release artifact builder
scripts/install.*          Per-user binary installers
tests/                     Bun tests and redacted fixtures
```

## Change workflow

1. Read the relevant adapter and [architecture](architecture.md) before changing session conversion.
2. Add or update a redacted fixture and focused test before changing a native format reader/writer.
3. Run `bun run check` before committing.
4. Build and smoke-test the current-platform binary after changing the CLI, assets, Bun APIs, or build scripts:

   ```sh
   bun run build
   ./dist/agent-connect-v<version>-<platform>
   ```

5. Update both root READMEs and relevant files under `docs/` for user-visible behavior.

## Session-store safety

Session stores may include prompts, terminal output, source code, credentials, and private file paths.

- Never commit real session JSONL, Cursor databases, generated reports, or unredacted logs.
- Prefer temporary directories, fixtures, injected adapters, and `AGENT_CONNECT_DATA_DIR` in tests.
- Cursor writes are especially sensitive: close Cursor completely and use a disposable SQLite fixture before testing write behavior.
- A migration must create a new target session. It must never edit the source session.

## Testing expectations

| Area | Minimum verification |
| --- | --- |
| Canonical events | Unit tests for mappings, counts, and report rendering |
| JSONL adapter | Read a redacted fixture and verify generated canonical events |
| Writer | Write to an isolated temporary root and re-read semantic invariants |
| Cursor | Use a disposable SQLite DB plus workspace storage fixture |
| CLI | Test `--help`, `--version`, `paths`, and safe mocked migration paths |
| Distribution | Compile a standalone binary and run `--version` / `--help` |

## Commit conventions

Use Conventional Commits:

```text
feat(scope): add behavior
fix(scope): correct behavior
docs: update documentation
chore: update tooling
```

Keep conversion behavior, generated artifacts, and documentation changes in reviewable commits. See [AGENTS.md](../AGENTS.md) for repository-wide guidance.
