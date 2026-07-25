#!/usr/bin/env node
// agent-connect CLI: Cursor / Claude Code / Codex CLI / Pi 会话互迁

// node:sqlite (读 Cursor) 需要 Node >= 23.4
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 23 || (major === 23 && minor < 4)) {
  console.error(`agent-connect 需要 Node.js >= 23.4 (当前 ${process.versions.node})`);
  console.error('升级: https://nodejs.org 或 nvm install 24');
  process.exit(1);
}

// 屏蔽 node:sqlite 的实验特性警告, 避免每次运行都刷屏
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  if (String(warning).includes('SQLite')) return;
  origEmitWarning(warning, ...args);
};

const { interactive } = await import('../src/commands/interactive.js');
const { list } = await import('../src/commands/list.js');
const { to } = await import('../src/commands/to.js');
const { install } = await import('../src/commands/install.js');

const HELP = `agent-connect — Cursor / Claude Code / Codex / Pi 会话互迁

用法:
  agent-connect                      交互式: 选会话 → 选目标工具 → 完成
  agent-connect list [--json]        跨工具列出当前项目的会话
  agent-connect to <目标> [会话id]    直达迁移, 目标 ∈ cursor|claude|codex|pi
                                     会话id 可为 id 前缀; 省略时取最近的非目标工具会话
  agent-connect install              安装 Claude Code 斜杠命令 (/resume-cursor 等)

说明:
  在项目目录下运行, 只列出该项目的会话
  转换策略一律默认 (全量保留, 不摘要不丢弃), 明细报告写入 .agent-connect/
  写入 Cursor 需要先完全退出 Cursor
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
      return interactive();
    case 'list':
      return list(args);
    case 'to':
      return to(args);
    case 'install':
      return install(args);
    default:
      process.stdout.write(HELP);
      process.exitCode = cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  process.exit(1);
});
