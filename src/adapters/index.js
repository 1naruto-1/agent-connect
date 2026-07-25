// 适配器注册表
import * as cursor from './cursor.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as pi from './pi.js';

export const adapters = { cursor, claude, codex, pi };

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) throw new Error(`未知工具: ${name} (支持: ${Object.keys(adapters).join(', ')})`);
  return a;
}

// 跨工具列出当前项目的会话, 按时间倒序
export function listAllSessions(cwd) {
  const all = [];
  for (const a of Object.values(adapters)) {
    if (!a.available()) continue;
    for (const s of a.listSessions(cwd)) all.push({ ...s, source: a.id, sourceLabel: a.label });
  }
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
