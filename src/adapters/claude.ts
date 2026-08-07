// Claude Code 适配器: ~/.claude/projects/<编码路径>/<sessionId>.jsonl
// 读取语义与官方 resume 对齐 (parentUuid 活跃链 / isSidechain / snip / compact), 核心移植见 claude-session.ts
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../platform/fs.ts';
import { homeDirectory } from '../platform/paths.ts';
import { normalizeTitle, titleFromEvents, titleFromMessage, untitledSession } from '../title.ts';
import {
  effectiveTranscript, isCompactBoundary, loadEffectiveTranscript, loadTranscriptEntries,
} from './claude-session.ts';
import type { CanonicalEvent, NativeRecord, ReadSessionResult, SessionInfo, ToolEvent, WriteSessionMeta, WriteSessionResult } from '../types.ts';

export const id = 'claude';
export const label = 'Claude Code';
const CLAUDE_VERSION = '2.1.201';

export function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

const projectsDir = () => path.join(homeDirectory(), '.claude', 'projects');
const projectDir = (cwd: string) => path.join(projectsDir(), encodeProjectDir(cwd));

export function available(): boolean {
  return fs.existsSync(path.join(homeDirectory(), '.claude'));
}

// Claude 标题优先级与官方 lite metadata 一致: custom-title > ai-title > 首条用户消息
function sessionTitle(customTitle: string, aiTitle: string, messages: NativeRecord[]): string {
  const explicit = normalizeTitle(customTitle) || normalizeTitle(aiTitle);
  if (explicit) return explicit;
  for (const l of messages) {
    if (l.type !== 'user' || l.isMeta) continue;
    if (typeof l.message?.content === 'string') {
      const derived = titleFromMessage(l.message.content);
      if (derived) return derived;
    }
  }
  return '';
}

export function listSessions(cwd: string): SessionInfo[] {
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const sessions: SessionInfo[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(dir, f);
    const effective = loadEffectiveTranscript(file);
    sessions.push({
      id: f.replace('.jsonl', ''),
      title: sessionTitle(effective.customTitle, effective.aiTitle, effective.messages) || '(无标题)',
      updatedAt: fs.statSync(file).mtimeMs,
      count: effective.messages.length,
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Claude 工具名 → 统一词表
function toCanonicalTool(use: NativeRecord): { tool: ToolEvent['tool']; input: ToolEvent['input'] } {
  const inp = use.input || {};
  const mcp = use.name?.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { tool: 'mcp', input: { server: mcp[1], toolName: mcp[2], args: inp } };
  switch (use.name) {
    case 'Bash': return { tool: 'terminal', input: { command: inp.command || '', description: inp.description } };
    case 'Read': return { tool: 'read', input: { path: inp.file_path || '' } };
    case 'Edit': return { tool: 'edit', input: { path: inp.file_path || '', oldText: inp.old_string ?? '', newText: inp.new_string ?? '' } };
    case 'Write': return { tool: 'write', input: { path: inp.file_path || '', content: inp.content ?? '' } };
    case 'Grep': return { tool: 'grep', input: { pattern: inp.pattern || '', path: inp.path } };
    case 'Glob': return { tool: 'glob', input: { pattern: inp.pattern || '', path: inp.path } };
    case 'WebSearch': return { tool: 'web-search', input: { query: inp.query || '' } };
    case 'WebFetch': return { tool: 'web-fetch', input: { url: inp.url || '' } };
    case 'TodoWrite': return { tool: 'todo', input: { todos: (inp.todos || []).map((t: NativeRecord) => ({ content: t.content, status: t.status })) } };
    case 'TaskCreate': return { tool: 'todo', input: { todos: [{ content: inp.subject || '', status: 'pending' }] } };
    case 'AskUserQuestion': return {
      tool: 'ask-user',
      input: { questions: (inp.questions || []).map((q: NativeRecord) => ({ question: q.question || '', options: (q.options || []).map((o: NativeRecord) => o.label) })) },
    };
    case 'Task': case 'Agent': return { tool: 'subagent', input: { prompt: inp.prompt || inp.description || '' } };
    default: return { tool: 'other', input: { name: use.name || 'unknown', args: inp } };
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => b.text || '').join('\n');
  return content == null ? '' : JSON.stringify(content);
}

export function readSession(cwd: string, sessionId: string): ReadSessionResult {
  const file = path.join(projectDir(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`未找到 Claude Code 会话: ${file}`);
  const entries = loadTranscriptEntries(file);
  // 与 Claude --resume 一致: 只迁移 parentUuid 活跃链上的消息
  const { messages, customTitle, aiTitle, abandonedCount, snippedCount } = effectiveTranscript(entries);

  const results = new Map<string, NativeRecord>();
  for (const l of messages) {
    if (l.type !== 'user' || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message.content) {
      if (b.type === 'tool_result') results.set(b.tool_use_id, b);
    }
  }

  const events: CanonicalEvent[] = [];
  const skipped: Record<string, number> = {};
  if (abandonedCount > 0) skipped['已废弃分支'] = abandonedCount;
  if (snippedCount > 0) skipped['已裁剪消息'] = snippedCount;

  for (const l of messages) {
    const ts = l.timestamp || new Date().toISOString();
    if (l.type === 'user') {
      const c = l.message?.content;
      if (l.isMeta) {
        events.push({ kind: 'marker', ts, text: resultText(c) });
      } else if (typeof c === 'string') {
        events.push({ kind: 'user', ts, text: c });
      } else if (Array.isArray(c)) {
        // 纯 tool_result 用户行已并入对应 tool 事件, 这里只取文本
        const text = c.filter((b: NativeRecord) => b.type === 'text').map((b: NativeRecord) => b.text).join('\n');
        if (text) events.push({ kind: 'user', ts, text });
      }
    } else if (l.type === 'assistant' && Array.isArray(l.message?.content)) {
      for (const b of l.message.content) {
        if (b.type === 'text') events.push({ kind: 'assistant-text', ts, text: b.text });
        else if (b.type === 'thinking') events.push({ kind: 'thinking', ts, text: b.thinking || '', signature: b.signature || '' });
        else if (b.type === 'tool_use') {
          const r = results.get(b.id);
          const { tool, input } = toCanonicalTool(b);
          events.push({ kind: 'tool', ts, tool, input, output: r ? resultText(r.content) : '', isError: r?.is_error || false, origName: b.name });
        }
      }
    } else if (isCompactBoundary(l)) {
      const summarized = l.compactMetadata?.messagesSummarized;
      events.push({
        kind: 'marker',
        ts,
        text: typeof summarized === 'number'
          ? `[Claude Code 曾在此处压缩上下文, 约 ${summarized} 条消息]`
          : '[Claude Code 曾在此处压缩上下文]',
      });
    } else if (l.type && l.type !== 'assistant') {
      skipped[l.type] = (skipped[l.type] || 0) + 1;
    }
  }
  return {
    title: sessionTitle(customTitle, aiTitle, messages) || titleFromEvents(events) || untitledSession(label, sessionId),
    events,
    skipped,
  };
}

// ---- 写入 ----

// 统一词表 → Claude 工具名与输入
function fromCanonicalTool(e: ToolEvent): { name: string; input: NativeRecord } {
  const i = e.input;
  switch (e.tool) {
    case 'terminal': return { name: 'Bash', input: { command: i.command, description: i.description } };
    case 'read': return { name: 'Read', input: { file_path: i.path } };
    case 'edit': return { name: 'Edit', input: { file_path: i.path, old_string: i.oldText, new_string: i.newText } };
    case 'write': return { name: 'Write', input: { file_path: i.path, content: i.content } };
    case 'grep': return { name: 'Grep', input: { pattern: i.pattern, path: i.path } };
    case 'glob': return { name: 'Glob', input: { pattern: i.pattern, path: i.path } };
    case 'web-search': return { name: 'WebSearch', input: { query: i.query } };
    case 'web-fetch': return { name: 'WebFetch', input: { url: i.url, prompt: '获取页面内容' } };
    case 'todo': return { name: 'TodoWrite', input: { todos: (i.todos || []).map((t: NativeRecord) => ({ content: t.content, status: t.status, activeForm: t.content })) } };
    case 'ask-user': return {
      name: 'AskUserQuestion',
      // 经 canonicalToolFromName 透传的源记录可能缺 question/options 字段
      input: { questions: (i.questions || []).map((q: NativeRecord) => ({ question: q.question || '', header: String(q.question || '').slice(0, 12), options: (q.options || []).map((o: unknown) => ({ label: o, description: '' })), multiSelect: false })) },
    };
    case 'subagent': return { name: 'Task', input: { description: '子代理任务', prompt: i.prompt } };
    case 'mcp': return { name: `mcp__${i.server}__${i.toolName}`.replace(/[^a-zA-Z0-9_]/g, '_'), input: i.args };
    default: return { name: String(i.name || 'UnknownTool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'UnknownTool', input: i.args || {} };
  }
}

export function writeReady(): string | null {
  return null;
}

export function writeSession(cwd: string, title: string, events: CanonicalEvent[], meta: WriteSessionMeta = {}): WriteSessionResult {
  const sessionId = randomUUID();
  const model = meta.sourceModel ? `${meta.source || 'import'}/${meta.sourceModel}` : 'agent-connect/import';
  const lines: NativeRecord[] = [];
  let lastUuid: string | null = null;
  let lastUserText = '';
  // Claude resume chooses the first record for equal timestamps. Canonical events
  // can legitimately share a timestamp, so make persisted transcript records strictly ordered.
  let lastTimestamp = -Infinity;
  const nextTimestamp = (sourceTs: string): string => {
    const parsed = Date.parse(sourceTs);
    const timestamp = Math.max(Number.isFinite(parsed) ? parsed : Date.now(), lastTimestamp + 1);
    lastTimestamp = timestamp;
    return new Date(timestamp).toISOString();
  };

  const env = (uuid: string, ts: string) => ({
    parentUuid: lastUuid, isSidechain: false, uuid, timestamp: ts,
    userType: 'external', entrypoint: 'cli', cwd, sessionId, version: CLAUDE_VERSION, gitBranch: '',
  });
  const emitUser = (content: unknown, ts: string, extra: NativeRecord = {}) => {
    const uuid = randomUUID();
    lines.push({ ...env(uuid, ts), type: 'user', promptId: randomUUID(), message: { role: 'user', content }, origin: { kind: 'human' }, promptSource: 'typed', permissionMode: 'default', ...extra });
    lastUuid = uuid;
    return uuid;
  };
  const emitAssistant = (blocks: NativeRecord[], ts: string, stopReason: string | null) => {
    const uuid = randomUUID();
    lines.push({
      ...env(uuid, ts), type: 'assistant',
      message: {
        id: `msg_migrated_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', model,
        content: blocks, stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    });
    lastUuid = uuid;
    return uuid;
  };

  lines.push({ type: 'mode', mode: 'normal', sessionId });
  lines.push({ type: 'permission-mode', permissionMode: 'default', sessionId });

  for (const e of events) {
    switch (e.kind) {
      case 'user':
        emitUser(e.text, nextTimestamp(e.ts));
        lastUserText = e.text;
        break;
      case 'assistant-text':
        emitAssistant([{ type: 'text', text: e.text }], nextTimestamp(e.ts), 'end_turn');
        break;
      case 'thinking':
        emitAssistant([{ type: 'thinking', thinking: e.text, signature: e.signature || '' }], nextTimestamp(e.ts), null);
        break;
      case 'marker':
        emitUser([{ type: 'text', text: e.text }], nextTimestamp(e.ts), { isMeta: true });
        break;
      case 'tool': {
        const { name, input } = fromCanonicalTool(e);
        const toolId = `toolu_migrated_${randomUUID().slice(0, 8)}`;
        const toolTs = nextTimestamp(e.ts);
        const assistantUuid = emitAssistant([{ type: 'tool_use', id: toolId, name, input }], toolTs, 'tool_use');
        const uuid = randomUUID();
        lines.push({
          ...env(uuid, nextTimestamp(e.ts)), type: 'user',
          message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: e.output ?? '', is_error: !!e.isError }] },
          sourceToolAssistantUUID: assistantUuid,
        });
        lastUuid = uuid;
        break;
      }
    }
  }

  if (title) lines.push({ type: 'ai-title', aiTitle: title, sessionId });
  lines.push({ type: 'last-prompt', lastPrompt: lastUserText, leafUuid: lastUuid, sessionId });

  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return {
    id: sessionId,
    resumeHint: `claude --resume ${sessionId}  (或在 Claude Code 中 /resume 选择《${title}》)`,
  };
}

export const writeNotes = [
  '思考块原样保留为 thinking 块 (API 忽略历史轮次 thinking, 不影响恢复)',
  '并列或倒序的事件时间会按记录顺序递增 1ms，确保 Claude Code 从最后一条记录续接',
  'MCP 调用保留完整记录 (目标端未配置同名 MCP 服务器时不可重新调用)',
];
