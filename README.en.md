# agent-connect

**Lossless session migration between Cursor, Claude Code, Codex CLI, and Pi** — continue a conversation started in one AI coding tool inside another. No handoff documents, no summaries.

[中文文档](README.md)

## Why

Context is trapped inside each AI coding tool. agent-connect converts a session **event by event** (full dialogue, thinking blocks, every tool call with its result, file edits, terminal output) and writes it into the target tool's **native session storage**, so you load it with the target tool's **own resume mechanism** and just say "continue".

## Quick start

Requires Node.js >= 23.4 (uses built-in `node:sqlite`; zero dependencies).

```bash
git clone https://github.com/1naruto-1/agent-connect.git
cd agent-connect && npm install -g .

cd your-project
agent-connect        # interactive: pick a session, pick a target tool, done
```

Other commands:

```bash
agent-connect list                # list all sessions of this project across tools
agent-connect to <target> [id]    # direct migration, target ∈ cursor|claude|codex|pi
agent-connect install             # install /resume-cursor /resume-codex /resume-pi for Claude Code
```

Resume the migrated session natively: `claude --resume <id>` / `codex resume <id>` / `pi --session <id>` / Cursor session history.

## How it works

Hub-and-spoke: one adapter (reader + writer) per tool around a canonical event stream — 4 adapters cover all 12 directions. Tool calls are mapped across a shared vocabulary (terminal, read/write/edit, search, web, todo, ask-user, subagent, MCP). Discipline: **everything is preserved by default — no silent summarization, no silent drops**; calls with no equivalent in the target become plain-text records with full arguments and results. Every migration writes a detail report to `.agent-connect/`.

Notes: writing into Cursor requires Cursor to be fully closed (only new rows are inserted, existing data is never touched). Verified on Windows with Cursor 3.9 / Claude Code 2.1 / Codex CLI 0.144 / Pi 0.82.

## License

MIT
