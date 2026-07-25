---
description: 将 Cursor 会话迁移为 Claude Code 原生会话 (用户选会话, 策略默认)
allowed-tools: Bash(agent-connect:*), Read
---

# 任务: 从 Cursor 迁移会话到 Claude Code

用户参数 (可能为空, 可能是会话 id 或标题关键词): $ARGUMENTS

1. 运行 `agent-connect list`, 只看 `[cursor]` 来源的会话。
   - $ARGUMENTS 能唯一匹配某会话 (id 前缀或标题) 则直接用它; 否则把 cursor 会话列表展示给用户, **由用户选择**, 不要替用户选。
2. 运行 `agent-connect to claude <会话id>`。策略一律默认 (全量保留), 不要就策略提问。
3. 向用户转述: 命令输出的迁移概要与报告路径, 以及"继续会话"提示中的恢复方式 (终端运行 `claude --resume <id>` 可自行附加启动参数, 或 /resume 选择同名会话)。
