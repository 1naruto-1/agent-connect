// list 子命令: 跨工具列出当前项目会话
import { listAllSessions } from '../adapters/index.js';

export function formatTime(ms) {
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
}

export async function list(args) {
  const sessions = listAllSessions(process.cwd());
  if (args.includes('--json')) {
    console.log(JSON.stringify(sessions.map(({ file, ...s }) => s), null, 1));
    return;
  }
  if (sessions.length === 0) {
    console.log(`当前项目 ${process.cwd()} 没有任何工具的会话。`);
    return;
  }
  for (const s of sessions) {
    console.log(`[${s.source.padEnd(6)}] ${formatTime(s.updatedAt)}  ${s.id.slice(0, 8)}  ${s.title}`);
  }
  console.log(`\n共 ${sessions.length} 个会话。迁移: agent-connect (交互式) 或 agent-connect to <目标> <会话id>`);
}
