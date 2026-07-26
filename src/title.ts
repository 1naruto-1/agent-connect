// 会话标题解析: 显式标题 → 首条可用用户消息 → 带 Harness 名称的兜底
// listSessions() 与 readSession() 必须共用这里的规则, 否则迁移写入目标 Harness 的会话名会与列表显示不一致
import type { CanonicalEvent } from './types.ts';

export const TITLE_MAX_LENGTH = 60;

// 迁移时插入的来源说明; 链式迁移中它不能充当标题
const PROVENANCE_PREFIX = '[agent-connect]';
// Harness 注入的包装消息, 如 Claude Code 的 <command-name>、<local-command-caveat>
const WRAPPER_TAG = /^<[a-z][\w-]*>/i;

const collapse = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

// Harness 已保存的显式标题 (ai-title、session_info.name、composer.name)
export function normalizeTitle(value: unknown): string {
  return collapse(value).slice(0, TITLE_MAX_LENGTH);
}

// 用户消息文本 → 标题候选; 迁移标记与包装消息返回空串
export function titleFromMessage(value: unknown): string {
  const text = collapse(value);
  if (!text || text.startsWith(PROVENANCE_PREFIX) || WRAPPER_TAG.test(text)) return '';
  return text.slice(0, TITLE_MAX_LENGTH);
}

// 统一事件流中第一条可用作标题的用户消息
export function titleFromEvents(events: CanonicalEvent[]): string {
  for (const event of events) {
    if (event.kind !== 'user') continue;
    const candidate = titleFromMessage(event.text);
    if (candidate) return candidate;
  }
  return '';
}

// 没有任何可用标题时的兜底; 裸会话 id 在目标 Harness 的历史里读不出含义
export function untitledSession(label: string, sessionId: string): string {
  return `${label} 会话 ${String(sessionId).slice(0, 8)}`;
}
