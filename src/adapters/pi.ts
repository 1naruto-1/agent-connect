// Pi 适配器: ~/.pi/agent/sessions/--<路径编码>--/<ts>_<uuid>.jsonl
// 会话是 JSONL 树 (id/parentId), 读取语义与 Pi 原版 SessionManager 对齐, 核心移植见 pi-session.ts
// 恢复: pi --resume (选择器) 或 pi --session <id>
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonicalToolFromName } from '../events.ts';
import { atomicWriteFileSync } from '../platform/fs.ts';
import { homeDirectory } from '../platform/paths.ts';
import { normalizeTitle, titleFromEvents, titleFromMessage, untitledSession } from '../title.ts';
import {
  PI_SESSION_VERSION, bashExecutionToText, buildSessionPath, generateEntryId,
  loadSessionEntries, messageActivityTime, migrateSessionEntries, sessionName,
} from './pi-session.ts';
import type { CanonicalEvent, NativeRecord, ReadSessionResult, SessionInfo, ToolEvent, WriteSessionResult } from '../types.ts';

export const id = 'pi';
export const label = 'Pi';

function expandTilde(value: string): string {
  if (value === '~') return homeDirectory();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDirectory(), value.slice(2));
  return value;
}

// pi 的 getAgentDir: 环境变量 PI_CODING_AGENT_DIR 优先, 默认 ~/.pi/agent
function agentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  return envDir ? expandTilde(envDir) : path.join(homeDirectory(), '.pi', 'agent');
}

// pi 的目录编码: `--${resolve(cwd) 去掉开头斜杠, [/\:] → -}--`
// PI_CODING_AGENT_SESSION_DIR 覆盖整个会话目录 (此时 pi 按 header.cwd 过滤, 见 listSessions)
function sessionDir(cwd: string): string {
  const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (envDir) return expandTilde(envDir);
  const safePath = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(agentDir(), 'sessions', safePath);
}

export function available(): boolean {
  return fs.existsSync(agentDir());
}

const blockText = (content: unknown): string =>
  typeof content === 'string' ? content : ((content as NativeRecord[]) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// 活跃分支上第一条可作标题的用户消息 (与 titleFromEvents 的规则一致)
function firstUserTitle(activePath: NativeRecord[]): string {
  for (const entry of activePath) {
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    const candidate = titleFromMessage(blockText(entry.message.content));
    if (candidate) return candidate;
  }
  return '';
}

// 标题规则与 readSession 共用: 最新 session_info (空名清除) → 活跃分支首条提问
function resolveTitle(body: NativeRecord[], activePath: NativeRecord[]): string {
  const explicit = sessionName(body);
  return (explicit ? normalizeTitle(explicit) : '') || firstUserTitle(activePath);
}

export function listSessions(cwd: string): SessionInfo[] {
  const dir = sessionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const filterCwd = !!process.env.PI_CODING_AGENT_SESSION_DIR;
  const resolvedCwd = path.resolve(cwd);
  const sessions: SessionInfo[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(dir, f);
    const entries = loadSessionEntries(file);
    if (!entries.length) continue;
    const header = entries[0]!;
    // 共享会话目录时 pi 只列出 header.cwd 归属当前项目的会话
    const headerCwd = typeof header.cwd === 'string' ? header.cwd : '';
    if (filterCwd && (!headerCwd || path.resolve(headerCwd) !== resolvedCwd)) continue;
    migrateSessionEntries(entries);
    const body = entries.filter((entry) => entry.type !== 'session');

    // pi 的 buildSessionInfo: messageCount 统计全部消息, modified 取最后一次 user/assistant 活动时间
    let messageCount = 0;
    let lastActivity: number | undefined;
    for (const entry of body) {
      if (entry.type !== 'message') continue;
      messageCount++;
      const activity = messageActivityTime(entry);
      if (typeof activity === 'number') lastActivity = Math.max(lastActivity ?? 0, activity);
    }
    const headerTime = Date.parse(String(header.timestamp || ''));
    const updatedAt = typeof lastActivity === 'number' && lastActivity > 0
      ? lastActivity
      : Number.isNaN(headerTime) ? fs.statSync(file).mtimeMs : headerTime;

    const title = resolveTitle(body, buildSessionPath(body)) || '(无标题)';
    sessions.push({ id: header.id, title, updatedAt, count: messageCount, file });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// pi 工具名 → 统一词表
function toCanonicalTool(call: NativeRecord): { tool: ToolEvent['tool']; input: ToolEvent['input'] } {
  const a = call.arguments || {};
  switch (call.name) {
    case 'bash': return { tool: 'terminal', input: { command: a.command || '' } };
    case 'read': return { tool: 'read', input: { path: a.path || a.file_path || '' } };
    case 'edit': return { tool: 'edit', input: { path: a.path || '', oldText: a.oldText ?? a.old_string ?? '', newText: a.newText ?? a.new_string ?? '' } };
    case 'write': return { tool: 'write', input: { path: a.path || '', content: a.content ?? '' } };
    case 'find': return { tool: 'glob', input: { pattern: a.pattern || a.glob || '', path: a.path } };
    case 'grep': return { tool: 'grep', input: { pattern: a.pattern || '', path: a.path } };
    case 'ls': return { tool: 'terminal', input: { command: `ls '${a.path || '.'}'` } };
    default: return canonicalToolFromName(call.name, a) || { tool: 'other', input: { name: call.name, args: a } };
  }
}

export function readSession(cwd: string, sessionId: string): ReadSessionResult {
  const dir = sessionDir(cwd);
  if (!fs.existsSync(dir)) throw new Error(`未找到 Pi 会话: ${sessionId}`);
  // 文件名为 <ts>_<uuid>.jsonl, 只匹配 uuid 段 (锚定开头), 避免部分 id 命中时间戳
  const wanted = String(sessionId).toLowerCase();
  const file = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)).find((f) => {
    const base = path.basename(f, '.jsonl');
    const idPart = base.slice(base.indexOf('_') + 1);
    return idPart.toLowerCase().startsWith(wanted);
  });
  if (!file) throw new Error(`未找到 Pi 会话: ${sessionId}`);
  const entries = loadSessionEntries(file);
  if (!entries.length) throw new Error(`Pi 会话文件无效: ${path.basename(file)}`);
  migrateSessionEntries(entries);
  const body = entries.filter((entry) => entry.type !== 'session');

  // 与 Pi 恢复会话的分支判定一致: leaf 取文件最后一条记录, 沿 parentId 回溯得到活跃分支;
  // 其余分支 (被 /tree 或回退重问放弃的路径) 不进入事件流, 只计入 skipped
  const active = buildSessionPath(body);
  const skipped: Record<string, number> = {};
  if (active.length < body.length) skipped['非活跃分支'] = body.length - active.length;

  // toolResult 按 toolCallId 索引 (只在活跃分支内配对)
  const results = new Map<string, NativeRecord>();
  for (const l of active) {
    if (l.type === 'message' && l.message?.role === 'toolResult') results.set(l.message.toolCallId, l.message);
  }

  const events: CanonicalEvent[] = [];
  for (const l of active) {
    const ts = l.timestamp || new Date().toISOString();
    switch (l.type) {
      case 'session_info': // 标题来源, 不进入事件流
        continue;
      case 'compaction':
        // Pi 恢复时用摘要替换更早的历史; 迁移按全量保留策略保留完整活跃分支, 摘要转为标记
        events.push({ kind: 'marker', ts, text: `[Pi 曾在此处压缩上下文, 摘要: ${String(l.summary || '')}]` });
        continue;
      case 'branch_summary':
        events.push({ kind: 'marker', ts, text: `[Pi 曾从另一分支返回此处, 分支摘要: ${String(l.summary || '')}]` });
        continue;
      case 'custom_message':
        events.push({ kind: 'marker', ts, text: blockText(l.content) });
        continue;
      case 'message':
        break;
      default: // thinking_level_change / model_change / custom / label 等状态行
        skipped[l.type] = (skipped[l.type] || 0) + 1;
        continue;
    }
    const m = l.message || {};
    if (m.role === 'user') {
      events.push({ kind: 'user', ts, text: blockText(m.content) });
    } else if (m.role === 'assistant') {
      if (m.stopReason === 'error' || m.stopReason === 'aborted') { skipped[`assistant(${m.stopReason})`] = (skipped[`assistant(${m.stopReason})`] || 0) + 1; continue; }
      for (const b of m.content || []) {
        if (b.type === 'text') events.push({ kind: 'assistant-text', ts, text: b.text });
        else if (b.type === 'thinking') events.push({ kind: 'thinking', ts, text: b.thinking || '', signature: b.thinkingSignature || '' });
        else if (b.type === 'toolCall') {
          const r = results.get(b.id);
          const { tool, input } = toCanonicalTool(b);
          events.push({ kind: 'tool', ts, tool, input, output: r ? blockText(r.content) : '', isError: r?.isError || false, origName: b.name });
        }
      }
    } else if (m.role === 'bashExecution') {
      // 用户的 ! 命令; !! 前缀被 pi 排除出上下文, 迁移同样跳过
      if (m.excludeFromContext) { skipped['bashExecution(!!)'] = (skipped['bashExecution(!!)'] || 0) + 1; continue; }
      events.push({ kind: 'user', ts, text: bashExecutionToText(m) });
    } else if (m.role === 'custom') {
      // 扩展注入的消息, pi 会作为用户消息进入上下文; 迁移保留为标记
      events.push({ kind: 'marker', ts, text: blockText(m.content) });
    } else if (m.role !== 'toolResult') { // toolResult 已合并
      skipped[`message(${m.role})`] = (skipped[`message(${m.role})`] || 0) + 1;
    }
  }
  return { title: resolveTitle(body, active) || titleFromEvents(events) || untitledSession(label, sessionId), events, skipped };
}

// ---- 写入 ----

// 统一词表 → pi 工具调用
function toPiTool(e: ToolEvent): { name: string; arguments: NativeRecord } {
  const i = e.input;
  switch (e.tool) {
    case 'terminal': return { name: 'bash', arguments: { command: i.command } };
    case 'read': return { name: 'read', arguments: { path: i.path } };
    case 'edit': return { name: 'edit', arguments: { path: i.path, oldText: i.oldText, newText: i.newText } };
    case 'write': return { name: 'write', arguments: { path: i.path, content: i.content } };
    case 'glob': return { name: 'find', arguments: { pattern: i.pattern, ...(i.path ? { path: i.path } : {}) } };
    case 'grep': return { name: 'grep', arguments: { pattern: i.pattern, ...(i.path ? { path: i.path } : {}) } };
    case 'web-search': return { name: 'web_search', arguments: { query: i.query } };
    case 'web-fetch': return { name: 'web_fetch', arguments: { url: i.url } };
    case 'todo': return { name: 'todo_write', arguments: { todos: i.todos } };
    case 'ask-user': return { name: 'ask_user', arguments: { questions: i.questions } };
    case 'subagent': return { name: 'task', arguments: { prompt: i.prompt } };
    case 'mcp': return { name: `${i.server}_${i.toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_'), arguments: i.args || {} };
    default: return { name: String(i.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_'), arguments: i.args || {} };
  }
}

function uuidV7(ms = Date.now()): string {
  const hex = ms.toString(16).padStart(12, '0');
  const rand = randomUUID().replaceAll('-', '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16)}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

export function writeReady(): string | null {
  return null;
}

export function writeSession(cwd: string, title: string, events: CanonicalEvent[]): WriteSessionResult {
  const now = new Date();
  const sessionId = uuidV7(now.getTime());
  const iso = now.toISOString();
  const lines: NativeRecord[] = [];
  const usedIds = new Set<string>();
  let lastId: string | null = null;
  const entry = (obj: NativeRecord, ts: string) => {
    const entryId = generateEntryId(usedIds);
    usedIds.add(entryId);
    lines.push({ ...obj, id: entryId, parentId: lastId, timestamp: ts });
    lastId = entryId;
  };

  lines.push({ type: 'session', version: PI_SESSION_VERSION, id: sessionId, timestamp: iso, cwd: path.resolve(cwd) });
  // pi 的 appendSessionInfo 会清洗换行
  entry({ type: 'session_info', name: title.replace(/[\r\n]+/g, ' ').trim() }, iso);

  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content: NativeRecord[], ts: string, stopReason = 'stop') => entry({
    type: 'message',
    message: { role: 'assistant', content, api: 'anthropic-messages', provider: 'agent-connect', model: 'imported', usage: zeroUsage, stopReason, timestamp: Date.parse(ts) || Date.now() },
  }, ts);

  for (const e of events) {
    switch (e.kind) {
      case 'user':
        entry({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: e.text }], timestamp: Date.parse(e.ts) || Date.now() } }, e.ts);
        break;
      case 'marker':
        entry({ type: 'custom_message', customType: 'agent-connect', content: e.text, display: true }, e.ts);
        break;
      case 'assistant-text':
        assistant([{ type: 'text', text: e.text }], e.ts);
        break;
      case 'thinking':
        assistant([{ type: 'thinking', thinking: e.text, ...(e.signature ? { thinkingSignature: e.signature } : {}) }], e.ts);
        break;
      case 'tool': {
        const t = toPiTool(e);
        const toolCallId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        assistant([{ type: 'toolCall', id: toolCallId, name: t.name, arguments: t.arguments }], e.ts, 'toolUse');
        entry({
          type: 'message',
          message: { role: 'toolResult', toolCallId, toolName: t.name, content: [{ type: 'text', text: e.output ?? '' }], isError: !!e.isError, timestamp: Date.parse(e.ts) || Date.now() },
        }, e.ts);
        break;
      }
    }
  }

  const dir = sessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const fileTs = iso.replace(/[:.]/g, '-');
  atomicWriteFileSync(path.join(dir, `${fileTs}_${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { id: sessionId, resumeHint: `pi --session ${sessionId}  (或 pi --resume 选择《${title}》)` };
}

export const writeNotes = [
  '工具调用映射为 pi 内置工具 (bash/read/edit/write/find/grep), 其余保留原名',
  '思考块原样保留为 thinking 块',
];
