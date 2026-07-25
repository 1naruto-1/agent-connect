import { listAllSessions } from '../adapters/index.ts';
import type { ListedSession } from '../types.ts';

export function formatTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toISOString().slice(5, 16).replace('T', ' ');
}

export async function list(args: string[]): Promise<void> {
  const sessions = listAllSessions(process.cwd());
  if (args.includes('--json')) {
    console.log(JSON.stringify(sessions.map(({ file: _file, ...session }: ListedSession) => session), null, 2));
    return;
  }
  if (sessions.length === 0) {
    console.log(`当前项目 ${process.cwd()} 没有任何已支持 Harness 的会话。`);
    return;
  }
  for (const session of sessions) console.log(`[${session.source.padEnd(6)}] ${formatTime(session.updatedAt)}  ${session.id.slice(0, 8)}  ${session.title}`);
  console.log(`\n共 ${sessions.length} 个会话。迁移：agent-connect（交互式）或 agent-connect to <目标> <会话 id>`);
}
