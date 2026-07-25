// to 子命令: 直达迁移
import { listAllSessions, adapters } from '../adapters/index.js';
import { migrate } from '../migrate.js';

export async function to(args) {
  const targetId = args[0];
  const ref = args[1];
  if (!targetId || !adapters[targetId]) {
    throw new Error(`用法: agent-connect to <cursor|claude|codex|pi> [会话id]`);
  }
  const cwd = process.cwd();
  const sessions = listAllSessions(cwd);

  let session;
  if (ref) {
    session = sessions.find((s) => s.id.startsWith(ref)) || sessions.find((s) => s.title.includes(ref));
    if (!session) throw new Error(`没有匹配 "${ref}" 的会话, 用 agent-connect list 查看。`);
  } else {
    session = sessions.find((s) => s.source !== targetId);
    if (!session) throw new Error(`当前项目没有可迁移到 ${targetId} 的会话。`);
  }
  if (session.source === targetId) throw new Error(`会话 ${session.id.slice(0, 8)} 本来就是 ${targetId} 的会话。`);

  console.log(`迁移: [${session.source}]《${session.title}》 → ${targetId}`);
  const r = migrate(cwd, session.source, session.id, targetId);
  console.log(`完成: ${r.summary}`);
  console.log(`报告: ${r.reportFile}`);
  console.log(`\n继续会话: ${r.resumeHint}`);
  return r;
}
