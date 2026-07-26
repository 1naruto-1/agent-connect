# Agent Connect

**Continue the same coding-agent session across Harnesses.**

Agent Connect transfers native session history between **Cursor, Claude Code, Codex CLI, and Pi**, covering all 12 directions. It reads a source Harness's local session records and creates a new native session for the target Harness—without replaying the conversation through a model.

[简体中文](README.md) · [Architecture](docs/architecture.md) · [Development](docs/development-environment.md)

## Install

Agent Connect is distributed as a standalone binary. You do not need Node.js, npm, or Bun to use it.

### Windows

```powershell
irm https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.ps1 | iex
```

The installer resolves the latest published stable GitHub Release, downloads the matching `agent-connect-v<version>-windows-x64.exe`, and verifies it against that release's `SHA256SUMS`. It places `agent-connect.exe` in `%USERPROFILE%\.local\bin` and adds that directory to your user `PATH` only when needed. Open a new terminal afterwards.

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.sh | sh
```

The installer resolves the latest published stable GitHub Release, downloads the matching operating-system and CPU artifact, verifies it against the release `SHA256SUMS` file, then atomically installs it as `~/.local/bin/agent-connect`, and updates the relevant POSIX shell `PATH` configuration when needed. Start a new shell before verification; fish users should run the printed `fish_add_path` command.

The quick-install commands fetch the installer itself from the mutable `main` branch. For reproducible or security-sensitive installation, inspect and run the [tagged, version-pinned installer](docs/distribution.md#how-installers-resolve-a-release). `SHA256SUMS` detects corruption but is not an independent signature because it is distributed with the binaries.

Verify the installation:

```sh
agent-connect --version
agent-connect paths
```

## Continue a session

Run Agent Connect from the project that owns the source session:

```sh
cd /path/to/your-project
agent-connect
```

Choose a source session and then a target Harness. The resulting session is resumed through the target's normal mechanism:

| Target Harness | Resume command |
| --- | --- |
| Claude Code | `claude --resume <id>` or `/resume` |
| Codex CLI | `codex resume <id>` |
| Pi | `pi --session <id>` or `pi --resume` |
| Cursor | Open the project and select the session from history |

## Commands

| Command | Purpose |
| --- | --- |
| `agent-connect` | Interactively select one source session and target Harness |
| `agent-connect list [--json]` | List sessions for the current project |
| `agent-connect to <target> [session]` | Migrate one session directly to `cursor`, `claude`, `codex`, or `pi` |
| `agent-connect install` | Install embedded Claude Code slash commands |
| `agent-connect paths` | Show binary, data, and report locations |
| `agent-connect --version` | Show the installed semantic version |

After `agent-connect install`, Claude Code can use `/resume-cursor`, `/resume-codex`, and `/resume-pi`.

## What is preserved

Agent Connect preserves ordered user messages, assistant text, available thinking blocks, tool calls, inputs, outputs, errors, file edits, terminal results, search/web activity, todos, questions, subagents, and MCP calls.

The session title carries over too: Agent Connect reuses the title the source Harness stored, and falls back to the first user prompt when the source keeps no explicit title.

A shared canonical event stream sits between a source and target adapter. If the target Harness has no native form for a tool call, Agent Connect keeps the original arguments and result as readable text instead of silently dropping it. A migration always creates a new target session; it never changes the source session.

## Data locations

Agent Connect stores its own migration reports outside your project. It never creates `.agent-connect/` in a project.

| Platform | Agent Connect data and reports |
| --- | --- |
| Windows | `%APPDATA%\agent-connect` |
| macOS | `~/Library/Application Support/agent-connect` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/agent-connect` |

Use `AGENT_CONNECT_DATA_DIR` only when you intentionally need to override this location, such as isolated development or CI. Native Cursor, Claude Code, Codex, and Pi session stores remain managed by their respective tools.

## Notes

- Run the command from the project whose sessions you want to list or migrate.
- Writing to Cursor requires Cursor to be completely closed, including its tray process.
- Every migration creates a new session; there is currently no built-in batch mode or duplicate-import detection.
- Codex's native reasoning format cannot be generated; imported thinking is preserved as an assistant message prefixed with `[思考过程]`.
- Native session formats may change across versions. The currently validated environment is Windows with Cursor 3.9, Claude Code 2.1, Codex CLI 0.144, and Pi 0.82.
- Check the centrally stored migration report before filing an issue, and remove prompts, paths, terminal output, and credentials from reports you share.

## Development

Contributors need Bun 1.3.14 or newer. Read the repository [contributor rules](AGENTS.md), [development environment](docs/development-environment.md), [development workflow](docs/development.md), and maintainer [CI and release checklist](docs/distribution.md).

## License

[MIT](LICENSE)
