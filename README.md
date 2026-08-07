# Agent Connect

**让同一份 Agent 会话在不同 Harness 之间继续。**

目前支持 **Cursor、Claude Code、Codex CLI 和 Pi**，覆盖四者之间全部 12 个迁移方向。

[English](README.en.md) · [Architecture](docs/architecture.md) · [开发环境](docs/development-environment.md)

## 功能

不同 Agent Harness 的会话彼此隔离：在 Cursor 中完成一半的任务，切换到 Claude Code、Codex 或 Pi 后，通常只能重新描述需求，或者手工整理一份交接摘要。

Agent Connect 直接读取源 Harness 的本地会话记录，将其转换成统一事件流，再写入目标 Harness 的原生会话存储。迁移完成后，可以使用目标工具自己的恢复方式继续工作，不需要重新生成历史，也不需要手写交接文档。

迁移内容包括：

- 用户消息与助手回复
- 思考块（源存储可读取且目标格式支持时）
- 工具调用、调用参数、执行结果与错误状态
- 文件读取、写入和编辑记录
- 终端命令与输出
- 搜索、网页、待办、用户提问、子代理和 MCP 调用
- 会话标题：优先沿用源 Harness 保存的标题，没有则取首条用户提问

目标 Harness 没有对应工具格式时，Agent Connect 会把完整参数和结果保留为可读文本，而不是静默丢弃。每次迁移都会在平台标准的 Agent Connect 数据目录中生成报告，方便核对处理结果；不会在项目中创建 `.agent-connect/`。

## 快速开始

Agent Connect 以独立二进制发布。使用者不需要安装 Node.js、npm 或 Bun。

### 安装

#### Windows

```powershell
irm https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.ps1 | iex
```

安装器会解析最新发布的稳定版 GitHub Release，下载其中的 `agent-connect-v<版本>-windows-x64.exe` 并按照该 Release 的 `SHA256SUMS` 校验。随后将其安装到 `%USERPROFILE%\.local\bin`；若该目录尚未位于用户 `PATH`，会自动追加。安装后请打开新的终端。

#### macOS 与 Linux

```sh
curl -fsSL https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.sh | sh
```

安装器会解析最新发布的稳定版 GitHub Release，按照当前操作系统和 CPU 架构下载二进制，先按照该 Release 的 `SHA256SUMS` 校验，再原子地安装到 `~/.local/bin/agent-connect`；必要时会将安装目录写入 POSIX Shell 的 `PATH` 配置。验证前请打开新 Shell；fish 用户需要执行安装器输出的 `fish_add_path` 命令。

上述快速安装命令会从可变的 `main` 分支获取安装器本身。需要可复现或更严格的安全验证时，请检查并使用[带 Tag 且固定版本的安装方式](docs/distribution.md#how-installers-resolve-a-release)。`SHA256SUMS` 可以发现损坏，但它与二进制一同发布，并不是独立签名。

验证安装：

```sh
agent-connect --version
agent-connect paths
```

### 接续会话

进入会话所属的项目目录，然后运行：

```bash
cd /path/to/your-project
agent-connect
```

按照提示完成两步：

1. 选择需要接续的源会话。
2. 选择目标 Harness。

迁移完成后，终端会显示事件统计、迁移报告路径和目标会话的恢复命令：

```text
完成: 用户消息×3, 助手正文×27, 思考块×28, 工具调用 read×2, web-search×8
报告: %APPDATA%\agent-connect\reports\<项目哈希>\report-...md

继续会话: claude --resume 0c8ccb21-...
```

## 使用方法

| 命令 | 作用 |
| --- | --- |
| `agent-connect` | 交互式选择一个源会话和目标 Harness |
| `agent-connect list` | 列出当前项目在所有已支持 Harness 中的会话 |
| `agent-connect list --json` | 以 JSON 格式输出会话列表 |
| `agent-connect to <目标> [会话]` | 直接迁移一个会话，目标为 `cursor`、`claude`、`codex` 或 `pi` |
| `agent-connect install` | 安装 Claude Code 斜杠命令 |
| `agent-connect paths` | 显示二进制、数据和报告目录 |
| `agent-connect update [--check] [版本号]` | 自更新到最新发布；`--check` 仅检查是否有新版本 |
| `agent-connect --version` | 显示语义化版本号 |

`agent-connect to` 的会话参数可以使用会话 ID 前缀或标题关键词；省略时，会选择最近一个来源不同于目标 Harness 的会话。

安装斜杠命令后，可以在 Claude Code 中使用：

- `/resume-cursor`
- `/resume-codex`
- `/resume-pi`

这些命令用于把对应 Harness 的会话接续到 Claude Code。其他迁移方向使用终端 CLI。

### 恢复目标会话

| 目标 Harness | 恢复方式 |
| --- | --- |
| Claude Code | `claude --resume <id>`，或在 Claude Code 中使用 `/resume` |
| Codex CLI | `codex resume <id>` |
| Pi | `pi --session <id>`，或使用 `pi --resume` |
| Cursor | 启动 Cursor 打开当前项目，在会话历史中选择同名会话 |

## 接续原理

Agent Connect 使用中心辐射架构：每个 Harness 提供一个读取器和写入器，中间通过统一事件流连接。因此，4 个适配器即可覆盖 12 个迁移方向，而不需要为每一对工具单独实现转换器。

```text
源 Harness 原生会话
        │
        ▼
   Source Adapter
        │
        ▼
    统一事件流
        │
        ▼
   Target Adapter
        │
        ▼
目标 Harness 原生会话
```

迁移不会调用模型重放历史，也不会修改源会话。目标适配器会生成新的会话 ID，并按照目标 Harness 的原生格式写入消息、思考块、工具调用和结果。

| Harness | 原生会话存储 | 读取 | 写入 |
| --- | --- | --- | --- |
| Cursor | `state.vscdb`（SQLite） | 支持，只读打开 | 支持，需要完全退出 Cursor |
| Claude Code | `~/.claude/projects/*/*.jsonl` | 支持 | 支持 |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | 支持 | 支持 |
| Pi | `~/.pi/agent/sessions/--<项目>--/*.jsonl` | 支持 | 支持 |

Pi 会话是一棵记录树：回退重问或 `/tree` 切换会留下被放弃的分支。Agent Connect 与 Pi 原版的恢复判定一致，只迁移活跃分支（从文件最后一条记录沿 `parentId` 回溯到根），被放弃的分支计入迁移报告的跳过统计。

Claude Code 会话同样是追加式 JSONL 消息树：回退或重试会留下废弃的 `parentUuid` 分支。Agent Connect 与官方 `--resume` 一致，只迁移从最近一条非 sidechain 消息回溯到根的活跃链；`snip` 裁剪与废弃分支计入跳过统计，`compact_boundary` 保留为标记。

Codex rollout 是追加式 JSONL：用户回退会追加 `thread_rolled_back`。Agent Connect 与 Codex 原版 resume 一致，只迁移回退后仍有效的轮次；被丢弃的轮次计入迁移报告的跳过统计。分页格式中的 `item_completed`（`UserMessage`）与旧版 `user_message` 均可识别。

更完整的事件模型、适配器契约和存储说明见 [架构文档](docs/architecture.md)。

## 数据存储位置

Agent Connect 仅将自身生成的迁移报告存入平台标准数据目录；Cursor、Claude Code、Codex CLI 和 Pi 的原生会话仍由各自工具管理。

| 平台 | Agent Connect 数据和报告目录 |
| --- | --- |
| Windows | `%APPDATA%\agent-connect` |
| macOS | `~/Library/Application Support/agent-connect` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/agent-connect` |

只有在 CI 或隔离开发等场景才使用 `AGENT_CONNECT_DATA_DIR` 覆盖数据目录。

## 注意事项

- **只处理当前项目的会话**：请在会话所属的项目目录中运行 Agent Connect。
- **写入 Cursor 前必须退出 Cursor**：包括系统托盘中的 Cursor 进程；从 Cursor 读取会话不受影响。
- **每次迁移都会创建新会话**：当前没有内置批量迁移和重复导入检测。
- **Codex 思考块会降级显示**：Codex 的原生 reasoning 内容采用无法直接构造的格式，因此会以带 `[思考过程]` 前缀的助手消息保留。
- **原生格式可能随版本变化**：当前验证环境为 Windows、Cursor 3.9、Claude Code 2.1、Codex CLI 0.144 和 Pi 0.82。

如果迁移结果显示异常，请查看平台数据目录下的报告，并在提交 Issue 前移除其中的路径、提示词、终端输出和凭据等敏感信息。

## 开发

协作者需要 Bun 1.3.14 或更高版本。请阅读仓库的[贡献规则](AGENTS.md)、[开发环境](docs/development-environment.md)、[开发工作流](docs/development.md)与维护者使用的 [CI 和发行清单](docs/distribution.md)。

## License

[MIT](LICENSE)
