import { adapters, isAdapterId, listAllSessions } from '../adapters/index.ts';
import { migrate } from '../migrate.ts';
import type { AdapterId, ListedSession } from '../types.ts';

export function selectSession(sessions: ListedSession[], targetId: AdapterId, reference?: string): ListedSession {
  if (!reference) {
    const recent = sessions.find((candidate) => candidate.source !== targetId);
    if (!recent) throw new Error(`当前项目没有可迁移到 ${targetId} 的会话。`);
    return recent;
  }

  const exact = sessions.find((candidate) => candidate.id === reference);
  const matches = exact ? [exact] : sessions.filter((candidate) => candidate.id.startsWith(reference) || candidate.title.includes(reference));
  if (matches.length === 0) throw new Error(`没有匹配 "${reference}" 的会话，请使用 agent-connect list 查看。`);
  if (matches.length > 1) {
    const candidates = matches.slice(0, 10).map((candidate) => `[${candidate.source}] ${candidate.id.slice(0, 8)} ${candidate.title}`).join('\n');
    throw new Error(`"${reference}" 匹配多个会话；请使用更长的会话 ID 前缀。\n${candidates}`);
  }
  return matches[0]!;
}

export async function to(args: string[]): Promise<void> {
  const targetRef = args[0];
  const reference = args[1];
  if (!targetRef || !isAdapterId(targetRef)) throw new Error('用法: agent-connect to <cursor|claude|codex|pi> [会话 id]');
  const targetId = targetRef;
  const cwd = process.cwd();
  const session = selectSession(listAllSessions(cwd), targetId, reference);
  if (session.source === targetId) throw new Error(`会话 ${session.id.slice(0, 8)} 本来就是 ${targetId} 的会话。`);
  if (!adapters[targetId].available()) throw new Error(`未发现 ${adapters[targetId].label} 的本地会话存储。`);

  console.log(`迁移：[${session.source}]《${session.title}》 → ${targetId}`);
  const result = migrate(cwd, session.source, session.id, targetId);
  console.log(`完成：${result.summary}`);
  console.log(`报告：${result.reportFile}`);
  console.log(`\n继续会话：${result.resumeHint}`);
}
