import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import resumeCodex from '../../commands/resume-codex.md' with { type: 'text' };
import resumeCursor from '../../commands/resume-cursor.md' with { type: 'text' };
import resumePi from '../../commands/resume-pi.md' with { type: 'text' };

const templates: ReadonlyArray<readonly [string, string]> = [
  ['resume-cursor.md', resumeCursor],
  ['resume-codex.md', resumeCodex],
  ['resume-pi.md', resumePi],
];

// These templates are embedded in standalone binaries, so no repository-relative runtime path is used.
export async function install(): Promise<void> {
  const dir = path.join(os.homedir(), '.claude', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of templates) {
    fs.writeFileSync(path.join(dir, fileName), content, 'utf8');
    console.log(`已安装: /${fileName.replace('.md', '')}`);
  }
  console.log('\n在 Claude Code 中执行 /resume-cursor、/resume-codex、/resume-pi 即可迁入会话；');
  console.log('其他方向在终端运行 agent-connect（交互式）即可。');
}
