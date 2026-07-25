# agent-connect

**在 Cursor、Claude Code、Codex CLI、Pi 之间无损迁移会话** —— 在一个工具里开始的对话，搬到另一个工具里继续，不写交接文档，不做摘要。

[English](README.md) · [Architecture](docs/architecture.md)

## 它解决什么问题

不同 AI 编程工具的上下文互不相通：在 Cursor 里做了一半的项目，想换 Claude Code 继续，只能写交接文档重新描述——效果远不如原对话。agent-connect 把会话**逐事件**（完整对话、思考块、每一次工具调用与结果、文件编辑、终端输出）转换后写入目标工具的**原生会话存储**，用目标工具**自己的恢复机制**加载，打开直接说"继续"。

## 30 秒上手

```bash
# 安装 (需要 Node.js >= 23.4)
git clone https://github.com/1naruto-1/agent-connect.git
cd agent-connect && npm install -g .

# 在你的项目目录里运行
cd 你的项目
agent-connect
```

跟着提示走两步——选会话、选目标工具——完成后按提示用目标工具原生方式打开：

```
当前项目的会话 (5 个):

   1. [cursor] 07-24 15:08  设计跨工具上下文迁移
   2. [claude] 07-24 13:55  安装 brainstorming
   3. [codex ] 07-21 07:08  重构登录模块
   ...

迁移哪个会话? 输入编号: 1

  1. Claude Code
  2. Codex CLI
  3. Pi

迁移到哪个工具? 输入编号: 1

完成: 用户消息×3, 助手正文×27, 思考块×28, 工具调用 read×2, web-search×8 ...
继续会话: claude --resume 0c8ccb21-...  (或在 Claude Code 中 /resume 选择该会话)
```

## 全部用法

| 命令 | 作用 |
|---|---|
| `agent-connect` | 交互式迁移（推荐） |
| `agent-connect list` | 跨工具列出当前项目的所有会话 |
| `agent-connect to <目标> [会话id]` | 直达迁移，目标 ∈ `cursor` `claude` `codex` `pi`，id 可用前缀 |
| `agent-connect install` | 安装 Claude Code 斜杠命令 |

装完斜杠命令后，在 Claude Code 里可直接用 `/resume-cursor`、`/resume-codex`、`/resume-pi` 把其他工具的会话迁进来。

各工具的恢复方式（迁移完成时会原样打印）：

- **Claude Code**: `claude --resume <id>`，或 `/resume` 选择同名会话
- **Codex CLI**: `codex resume <id>`
- **Pi**: `pi --session <id>`，或 `pi --resume` 选择
- **Cursor**: 打开项目，会话历史里选择同名会话

## 迁移了什么、怎么迁

中心辐射架构：每个工具一个适配器（读 + 写），中间是统一事件流。4 个工具覆盖全部 12 个迁移方向。

| 工具 | 会话存储 | 读 | 写 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/*/`（JSONL） | ✓ | ✓ |
| Cursor | `state.vscdb`（SQLite，只读打开） | ✓ | ✓（需退出 Cursor） |
| Codex CLI | `~/.codex/sessions/`（JSONL） | ✓ | ✓ |
| Pi | `~/.pi/agent/sessions/`（JSONL） | ✓ | ✓ |

工具调用在统一词表间映射（终端、读/写/编辑文件、搜索、网页、待办、提问、子代理、MCP）。**转换纪律：默认全量保留，绝不擅自摘要或丢弃**；目标工具没有对应物的调用，转为参数与结果完整保留的正文文本；每次迁移的处理明细写入 `.agent-connect/report-*.md` 供核对。

## 常见问题

**报错 "Cursor 正在运行"** —— 写入 Cursor 数据库前必须完全退出 Cursor（系统托盘图标也要退出）。只读方向（从 Cursor 迁出）不受影响。

**报错 "需要 Node.js >= 23.4"** —— 读 Cursor 用了 Node 内置 `node:sqlite`（因此本工具零依赖）。`nvm install 24` 即可。

**迁到 Codex 后思考块显示为 `[思考过程]` 消息** —— Codex 的原生思考记录是加密格式无法构造，这是有意的降级表示，内容完整保留。

**列表里没有我的会话** —— agent-connect 按项目目录过滤会话，请在对应项目目录下运行。

**某方向迁移后显示异常** —— 各工具内部格式随版本演进（验证环境：Windows + Cursor 3.9 / Claude Code 2.1 / Codex 0.144 / Pi 0.82）。欢迎带着 `.agent-connect/` 下的报告开 issue。

## 文档

- [架构说明](docs/architecture.md)（英文）：仓库布局、统一事件模型、适配器、存储位置和迁移流程。

## License

MIT
