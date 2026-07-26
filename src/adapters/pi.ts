// Pi 适配器: ~/.pi/agent/sessions/--<路径编码>--/<ts>_<uuid>.jsonl
// 恢复: pi --resume (选择器) 或 pi --session <id>
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safeParse, canonicalToolFromName } from '../events.ts';
import { atomicWriteFileSync } from '../platform/fs.ts';
import { homeDirectory } from '../platform/paths.ts';
import { normalizeTitle, titleFromEvents, titleFromMessage, untitledSession } from '../title.ts';
import type { CanonicalEvent, NativeRecord, ReadSessionResult, SessionInfo, ToolEvent, WriteSessionResult } from '../types.ts';

export const id = 'pi';
export const label = 'Pi';

// pi 的目录编码: `--${cwd 去掉开头斜杠, [/\:] → -}--`
function sessionDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(homeDirectory(), '.pi', 'agent', 'sessions', safePath);
}

export function available(): boolean {
  return fs.existsSync(path.join(homeDirectory(), '.pi', 'agent'));
}

const parseLines = (file: string): NativeRecord[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => safeParse(l)).filter((o): o is NativeRecord => o !== null);

const blockText = (content: unknown): string =>
  typeof content === 'string' ? content : ((content as NativeRecord[]) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// session_info 可在会话中途多次出现, 取最后一个; 没有显式名称时退回首条用户消息
function sessionTitle(lines: NativeRecord[]): string {
  const explicit = lines.filter((l) => l.type === 'session_info' && l.name).at(-1)?.name;
  if (explicit) return normalizeTitle(explicit);
  for (const l of lines) {
    if (l.type !== 'message' || l.message?.role !== 'user') continue;
    const candidate = titleFromMessage(blockText(l.message.content));
    if (candidate) return candidate;
  }
  return '';
}

export function listSessions(cwd: string): SessionInfo[] {
  const dir = sessionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const sessions: SessionInfo[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(dir, f);
    const lines = parseLines(file);
    const header = lines.find((l) => l.type === 'session');
    if (!header) continue;
    sessions.push({ id: header.id, title: sessionTitle(lines) || '(无标题)', updatedAt: fs.statSync(file).mtimeMs, count: lines.length, file });
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
  const lines = parseLines(file);

  // toolResult 按 toolCallId 索引
  const results = new Map<string, NativeRecord>();
  for (const l of lines) {
    if (l.type === 'message' && l.message?.role === 'toolResult') results.set(l.message.toolCallId, l.message);
  }

  const events: CanonicalEvent[] = [];
  const skipped: Record<string, number> = {};
  for (const l of lines) {
    const ts = l.timestamp || new Date().toISOString();
    if (l.type === 'session_info' && l.name) continue;
    if (l.type === 'compaction') {
      events.push({ kind: 'marker', ts, text: `[Pi 曾在此处压缩上下文, 摘要: ${String(l.summary || '').slice(0, 200)}]` });
      continue;
    }
    if (l.type === 'custom_message') {
      events.push({ kind: 'marker', ts, text: blockText(l.content) });
      continue;
    }
    if (l.type !== 'message') {
      if (l.type !== 'session') skipped[l.type] = (skipped[l.type] || 0) + 1;
      continue;
    }
    const m = l.message;
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
    }
    // toolResult 已合并
  }
  return { title: sessionTitle(lines) || titleFromEvents(events) || untitledSession(label, sessionId), events, skipped };
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
  let lastId: string | null = null;
  const entry = (obj: NativeRecord, ts: string) => {
    const id = randomUUID().slice(0, 8);
    lines.push({ ...obj, id, parentId: lastId, timestamp: ts });
    lastId = id;
  };

  lines.push({ type: 'session', version: 3, id: sessionId, timestamp: iso, cwd });
  entry({ type: 'session_info', name: title }, iso);

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
