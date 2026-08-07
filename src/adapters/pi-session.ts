// Pi 会话文件核心语义, 移植自 earendil-works/pi packages/coding-agent/src/core/session-manager.ts
// 会话是追加式 JSONL 树: 首行为 session 头, 其余记录带 id/parentId; leaf 默认取文件最后一条记录,
// 活跃分支 = leaf 沿 parentId 回溯到根的路径 (Pi 恢复会话时只加载这条路径)
// 只读移植: 版本迁移仅在内存进行, 迁移工具不得改写源会话文件
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safeParse } from '../events.ts';
import type { NativeRecord } from '../types.ts';

export const PI_SESSION_VERSION = 3;

// pi 的 generateId: 8 位十六进制短 id, 碰撞检查, 极端情况下退回完整 UUID
export function generateEntryId(used: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const candidate = randomUUID().slice(0, 8);
    if (!used.has(candidate)) return candidate;
  }
  return randomUUID();
}

// pi 的 loadEntriesFromFile: 逐行解析并跳过坏行; 首条必须是带字符串 id 的 session 头, 否则整个文件无效
export function loadSessionEntries(file: string): NativeRecord[] {
  if (!fs.existsSync(file)) return [];
  const entries = fs.readFileSync(file, 'utf8').split('\n')
    .filter((line) => line.trim())
    .map((line) => safeParse(line))
    .filter((entry): entry is NativeRecord => entry !== null);
  if (entries.length === 0) return entries;
  const header = entries[0]!;
  if (header.type !== 'session' || typeof header.id !== 'string') return [];
  return entries;
}

// v1 → v2: 补上 id/parentId 线性链, compaction 的 firstKeptEntryIndex → firstKeptEntryId
function migrateV1ToV2(entries: NativeRecord[]): void {
  const ids = new Set<string>();
  let prevId: string | null = null;
  for (const entry of entries) {
    if (entry.type === 'session') { entry.version = 2; continue; }
    entry.id = generateEntryId(ids);
    ids.add(entry.id);
    entry.parentId = prevId;
    prevId = entry.id;
    if (entry.type === 'compaction' && typeof entry.firstKeptEntryIndex === 'number') {
      const target = entries[entry.firstKeptEntryIndex];
      if (target && target.type !== 'session') entry.firstKeptEntryId = target.id;
      delete entry.firstKeptEntryIndex;
    }
  }
}

// v2 → v3: hookMessage 角色更名为 custom
function migrateV2ToV3(entries: NativeRecord[]): void {
  for (const entry of entries) {
    if (entry.type === 'session') { entry.version = 3; continue; }
    if (entry.type === 'message' && entry.message?.role === 'hookMessage') entry.message.role = 'custom';
  }
}

// pi 的 migrateToCurrentVersion (仅内存, 不像 pi 那样回写文件)
export function migrateSessionEntries(entries: NativeRecord[]): void {
  const header = entries.find((entry) => entry.type === 'session');
  const version = typeof header?.version === 'number' ? header.version : 1;
  if (version >= PI_SESSION_VERSION) return;
  if (version < 2) migrateV1ToV2(entries);
  if (version < 3) migrateV2ToV3(entries);
}

// pi 的 buildSessionPath: 从 leaf (缺省取最后一条) 沿 parentId 回溯到根, 反转为时间顺序;
// parentId 指向不存在记录的孤儿条目在断点处截断 (视作根)
export function buildSessionPath(entries: NativeRecord[], leafId?: string | null): NativeRecord[] {
  if (leafId === null) return [];
  const index = new Map<string, NativeRecord>();
  for (const entry of entries) index.set(String(entry.id), entry);
  let leaf: NativeRecord | undefined;
  if (leafId) leaf = index.get(leafId);
  leaf ??= entries[entries.length - 1];
  if (!leaf) return [];

  const path: NativeRecord[] = [];
  const seen = new Set<string>();
  let current: NativeRecord | undefined = leaf;
  while (current) {
    const currentId = String(current.id);
    if (seen.has(currentId)) break;
    seen.add(currentId);
    path.push(current);
    current = current.parentId ? index.get(String(current.parentId)) : undefined;
  }
  path.reverse();
  return path;
}

// pi 的 getSessionName: 倒序取最新 session_info; 空名是显式清除标题
export function sessionName(entries: NativeRecord[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== 'session_info') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    return name || undefined;
  }
  return undefined;
}

// pi 的 getMessageActivityTime: 仅 user/assistant 消息计入活动时间
export function messageActivityTime(entry: NativeRecord): number | undefined {
  const message = entry.message;
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return undefined;
  if (typeof message.timestamp === 'number') return message.timestamp;
  const ts = new Date(String(entry.timestamp)).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

// pi 的 bashExecutionToText: ! 命令进入 LLM 上下文的文本形态
export function bashExecutionToText(message: NativeRecord): string {
  let text = `Ran \`${message.command}\`\n`;
  if (message.output) text += `\`\`\`\n${message.output}\n\`\`\``;
  else text += '(no output)';
  if (message.cancelled) text += '\n\n(command cancelled)';
  else if (message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  return text;
}
