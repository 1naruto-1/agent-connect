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
scripts/smoke-build.ts     Current-platform standalone binary smoke test
scripts/verify-checksums.ts Release checksum manifest verifier
scripts/install.*          Per-user binary installers
tests/                     Bun tests and inline redacted fixtures
```

## Change workflow

1. Read the relevant adapter and [architecture](architecture.md) before changing session conversion.
2. Add or update an inline redacted fixture and focused test before changing a native format reader/writer. Put reusable fixtures under `tests/fixtures/<adapter>/` if that directory is introduced.
3. Run `bun run check` before committing.
4. Build and smoke-test the current-platform binary after changing the CLI, assets, Bun APIs, or build scripts:

   ```sh
   bun run build
   bun run smoke:build
   ```

   `smoke:build` executes the host binary with `--version` and `--help`; do not launch the no-argument interactive migrator as a distribution smoke test.

5. Update both root READMEs and relevant files under `docs/` for user-visible behavior.
6. Open a pull request and require the Ubuntu, Windows, and macOS CI matrix jobs to pass before merging.

## CI and releases

`.github/workflows/ci.yml` runs the repository checks, native installer fixture, standalone build smoke test, and checksum verification on all three desktop operating systems. Keep local validation aligned with that workflow rather than adding undocumented release-only checks.

A pushed release tag triggers publication, not merely source packaging. Maintainers must read and follow the [distribution and release checklist](distribution.md) before creating any `v*` tag. Do not move or reuse a published tag.

## Session-store safety

Session stores may include prompts, terminal output, source code, credentials, and private file paths.

- Never commit real session JSONL, Cursor databases, generated reports, or unredacted logs.
- Prefer temporary directories, fixtures, injected adapters, and `AGENT_CONNECT_DATA_DIR` in tests.
- Cursor writes are especially sensitive: close Cursor completely and use a disposable SQLite fixture before testing write behavior.
- A migration must create a new target session. It must never edit the source session.

## Testing expectations

The table below lists minimum verification requirements for changes touching each area; it does not describe the current test suite.

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
