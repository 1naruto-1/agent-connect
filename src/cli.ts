import { install } from './commands/install.ts';
import { interactive } from './commands/interactive.ts';
import { list } from './commands/list.ts';
import { paths } from './commands/paths.ts';
import { to } from './commands/to.ts';
import { update } from './commands/update.ts';
import { VERSION } from './version.ts';

const HELP = `agent-connect — 在 Cursor / Claude Code / Codex / Pi 之间接续原生会话

用法：
  agent-connect                             交互式：选择会话 → 选择目标 Harness
  agent-connect list [--json]               列出当前项目的跨 Harness 会话
  agent-connect to <目标> [会话 id]          直达迁移；目标为 cursor|claude|codex|pi
  agent-connect install                     安装 Claude Code 斜杠命令
  agent-connect paths                       显示二进制、数据和报告目录
  agent-connect update [--check] [版本号]    自更新到最新发布（--check 仅检查）
  agent-connect --version                   显示版本

说明：
  在会话所属项目目录中运行；一次迁移一个会话。
  报告写入平台标准应用数据目录，不会在项目中创建 .agent-connect/。
  写入 Cursor 前必须完全退出 Cursor。
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case undefined: await interactive(); return 0;
    case 'list': await list(args); return 0;
    case 'to': await to(args); return 0;
    case 'install': await install(); return 0;
    case 'paths': await paths(); return 0;
    case 'update': await update(args); return 0;
    case '--version': case '-V': case 'version': console.log(VERSION); return 0;
    case '--help': case '-h': case 'help': process.stdout.write(HELP); return 0;
    default: process.stdout.write(HELP); return 1;
  }
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
