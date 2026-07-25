// install 子命令: 安装 Claude Code 斜杠命令到 ~/.claude/commands/
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function install() {
  const srcDir = fileURLToPath(new URL('../../commands/', import.meta.url));
  const dir = path.join(os.homedir(), '.claude', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.md')) continue;
    fs.copyFileSync(path.join(srcDir, f), path.join(dir, f));
    console.log(`已安装: /${f.replace('.md', '')}`);
  }
  console.log(`\n在 Claude Code 中执行 /resume-cursor、/resume-codex、/resume-pi 即可迁入会话;`);
  console.log(`其他方向在终端运行 agent-connect (交互式) 即可。`);
}
