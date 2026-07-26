import * as claudeModule from './claude.ts';
import * as codexModule from './codex.ts';
import * as cursorModule from './cursor.ts';
import * as piModule from './pi.ts';
import type { Adapter, AdapterId, ListedSession } from '../types.ts';

// 各模块已按 Adapter 接口类型化, 结构不匹配会在此处编译报错
export const adapters: Record<AdapterId, Adapter> = {
  cursor: cursorModule,
  claude: claudeModule,
  codex: codexModule,
  pi: piModule,
};

export function isAdapterId(value: string): value is AdapterId {
  return value in adapters;
}

export function getAdapter(name: AdapterId): Adapter {
  return adapters[name];
}

export function listAllSessions(cwd: string): ListedSession[] {
  const sessions: ListedSession[] = [];
  for (const adapter of Object.values(adapters)) {
    if (!adapter.available()) continue;
    for (const session of adapter.listSessions(cwd)) sessions.push({ ...session, source: adapter.id, sourceLabel: adapter.label });
  }
  return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
}
