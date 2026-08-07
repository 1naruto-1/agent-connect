# Architecture

[English](../README.en.md) · [简体中文](../README.md) · [Development environment](development-environment.md) · [Distribution](distribution.md)

## Overview

agent-connect migrates one coding-agent session at a time between Cursor, Claude Code, Codex CLI, and Pi. It does not replay the conversation against a model. Instead, it reads the source tool's persisted session, converts its meaningful history into a canonical event stream, and writes new historical records to the target tool's native session store. The target tool can then resume the imported session through its normal UI or CLI.

```text
source native store
  │
  ▼
source adapter: listSessions / readSession
  │
  ▼
canonical event stream
  │
  ▼
target adapter: writeReady / writeSession
  │
  ├──► target native store
  └──► <platform-data>/agent-connect/reports/<project-hash>/…
```

## Repository layout

```text
src/cli.ts                 Bun CLI entry point and command router
src/
  adapters/                One reader/writer adapter per supported tool
  commands/                Interactive, list, direct-migration, path, install, and self-update commands
  platform/paths.ts        Standard per-platform data and executable locations
  events.ts                Canonical event model, statistics, and report rendering
  migrate.ts               Read → normalize → annotate → write orchestration
  cursor.ts                Cursor SQLite read helpers using bun:sqlite
  cursor-writer.ts         Cursor SQLite write helpers and legacy composer shape
commands/                  Claude Code slash-command templates embedded at build time
scripts/                   Standalone binary build and release validation
README.md                  Simplified Chinese project documentation (default)
README.en.md               English project documentation
docs/                      Architecture, development, and distribution documentation
AGENTS.md                  Contributor and agent guidance
```

## Canonical event model

`src/events.ts` defines the loss-preserving interchange layer. Adapters produce and consume an ordered array of these event kinds:

| Event kind | Core fields | Purpose |
| --- | --- | --- |
| `user` | `ts`, `text` | A human prompt |
| `assistant-text` | `ts`, `text` | A visible assistant response |
| `thinking` | `ts`, `text`, `signature` | A recorded reasoning block where supported |
| `tool` | `ts`, `tool`, `input`, `output`, `isError`, `origName` | A tool call together with its result |
| `marker` | `ts`, `text` | Migration provenance, compaction, or an unsupported event record |

Tool calls use a small shared vocabulary: terminal, file read/write/edit, glob, grep, web search/fetch, todos, user questions, subagents, MCP, and `other`. A target adapter maps supported calls back to a native tool representation. When it cannot represent a call natively, it preserves its arguments and result as text rather than silently omitting it.

## Adapter contract

Every module in `src/adapters/` exports the same operational surface:

| Function / value | Responsibility |
| --- | --- |
| `id`, `label` | Stable CLI identifier and display name |
| `available()` | Whether the corresponding local tool storage is available |
| `listSessions(cwd)` | Find sessions belonging to the current project |
| `readSession(cwd, sessionId)` | Parse a native session into canonical events |
| `writeReady()` | Return a preflight error, if any, before a write |
| `writeSession(cwd, title, events)` | Persist canonical events in the target format |
| `writeNotes` | Target-specific notes included in the migration report |

`src/adapters/index.ts` is the single registry. Add an adapter there only after its reader and writer both satisfy this contract.

`listSessions()` and `readSession()` must resolve a title through the shared helpers in `src/title.ts`, because `readSession().title` becomes the session name in the target Harness. The order is: the explicit title the Harness stored (`ai-title`, `session_info.name`, `composer.name`) → the first user message that is neither an `[agent-connect]` provenance marker nor a Harness-injected wrapper such as `<command-name>` → `untitledSession()`, which names the source Harness instead of a bare session id. `listSessions()` skips the last step, since the id is already in the row.

## Native storage integrations

| Tool | Session store | Implementation notes |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | Writes JSONL messages, tool-use/result pairs, and session metadata. |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Writes rollout JSONL; reuses configuration details from a recent native Codex session when available. `codex-session.ts` ports Codex resume semantics: `thread_rolled_back` drops the newest N user turns from the effective history (counted as skipped), and paginated `item_completed`/`UserMessage` events are treated as user turns alongside legacy `user_message`. Compaction becomes a marker (summary text preserved when present). |
| Pi | `~/.pi/agent/sessions/--<project>--/*.jsonl` | Sessions are `id`/`parentId` record trees. `pi-session.ts` ports Pi's own `SessionManager` semantics: the reader follows the active branch (last record back to the root), applies v1→v3 format migration in memory only, and treats abandoned branches as skipped records. Compaction and branch summaries become markers. Writes a session header plus a linked record chain. |
| Cursor | Cursor `state.vscdb` SQLite database | Reads through `bun:sqlite`; writes only new rows after Cursor is fully closed. `cursor-writer.ts` constructs the legacy composer and bubble shapes. |

All adapters generate new target session identifiers. A migration never modifies the source session.

## Migration lifecycle

`migrate(cwd, sourceId, sessionId, targetId)` in `src/migrate.ts` performs the following steps:

1. Resolve source and target adapters and reject identical tools.
2. Run the target preflight check.
3. Read the selected source session into canonical events.
4. Add a provenance marker so the resumed agent knows the conversation was imported.
5. Write a new target-native session.
6. Store a human-readable report beneath the platform-standard Agent Connect data directory, grouped by a stable project-path hash.

The public CLI currently performs **one migration per invocation**. `agent-connect list --json` can support external automation, but there is no built-in batch mode or import deduplication.

## CLI and slash commands

`src/cli.ts` dispatches the following command modules:

| Command | Module | Role |
| --- | --- | --- |
| `agent-connect` | `src/commands/interactive.ts` | Pick one source session and one available target |
| `agent-connect list [--json]` | `src/commands/list.ts` | List sessions for the current project |
| `agent-connect to <target> [id]` | `src/commands/to.ts` | Directly migrate one selected session |
| `agent-connect install` | `src/commands/install.ts` | Install embedded Claude Code slash-command templates |
| `agent-connect paths` | `src/commands/paths.ts` | Show per-user binary, data, and report locations |
| `agent-connect update [--check] [version]` | `src/commands/update.ts` | Verify and atomically replace the running executable with a released build |

The Markdown files under `commands/` are Claude Code command prompts embedded into standalone binaries at build time; they are not session-format templates.

## Maintenance rules

- Keep native-format logic inside the relevant adapter; do not add tool-specific parsing to `migrate.ts` or `events.ts`.
- Preserve ordering, timestamps, inputs, outputs, and error status whenever a source format exposes them.
- Document unavoidable format downgrades in the adapter's `writeNotes` and verify that the migration report explains them.
- Treat session stores as sensitive data. Do not commit captured sessions, reports, tokens, or unredacted tool output.
- For Cursor writes, ensure the application and tray process are completely closed; the writer must only insert new session rows.
- Update both root READMEs, this document, and the applicable development/distribution guide when adding a tool, changing the canonical event vocabulary, a storage layout, or the release process.
