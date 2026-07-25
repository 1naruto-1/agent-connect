# Development environment

[Architecture](architecture.md) · [Development workflow](development.md) · [Distribution](distribution.md)

Agent Connect uses **Bun 1.3.14** and strict TypeScript for development. End users run a standalone binary and do **not** need Bun or Node.js installed.

## Required tools

| Tool | Required version | Why |
| --- | --- | --- |
| Bun | 1.3.14 or newer | Runtime, package manager, test runner, bundler, and `bun:sqlite` |
| Git | Current | Source checkout and release tags |

Install Bun from its official installer:

```powershell
# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

Verify the development environment:

```sh
bun --version
# Expected: 1.3.14 or newer
```

## First checkout

```sh
git clone https://github.com/1naruto-1/agent-connect.git
cd agent-connect
bun install --frozen-lockfile
bun run check
```

`bun install` creates `node_modules/` locally and uses the committed `bun.lock`. Do not use npm or add a Node lockfile.

## Daily commands

| Command | Purpose |
| --- | --- |
| `bun run dev -- --help` | Run the TypeScript CLI directly |
| `bun run typecheck` | Run `tsc --noEmit` with strict options |
| `bun test` | Run the Bun test suite |
| `bun run check` | Run type checking and tests together |
| `bun run build` | Build a standalone binary for the current platform |
| `bun run build -- --all` | Build every release target and `SHA256SUMS` |
| `bun run src/cli.ts paths` | Print the current application-data and executable locations |

## Isolated development data

Never develop or test against valuable live agent sessions. Override only Agent Connect's own data root when needed:

```sh
AGENT_CONNECT_DATA_DIR="$(mktemp -d)" bun run src/cli.ts paths
```

```powershell
$env:AGENT_CONNECT_DATA_DIR = Join-Path $env:TEMP 'agent-connect-dev'
bun run src/cli.ts paths
```

This override affects migration reports and future Agent Connect data only. It does not redirect Cursor, Claude Code, Codex CLI, or Pi session stores. Use redacted fixtures and temporary native-store roots for adapter tests.

## TypeScript boundaries

The canonical event model, path resolver, CLI, reports, build scripts, and tests are checked in strict TypeScript. Native Harness records are private, evolving JSON/SQLite formats; their compatibility adapters are temporarily isolated with `@ts-nocheck` until redacted fixtures model their schemas. Do not extend that exception: add validation, focused fixtures, and types whenever a native format changes.
