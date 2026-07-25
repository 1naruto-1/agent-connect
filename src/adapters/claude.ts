// @ts-nocheck
// Claude Code 适配器: ~/.claude/projects/<编码路径>/<sessionId>.jsonl
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safeParse } from '../events.ts';

export const id = 'claude';
export const label = 'Claude Code';
const CLAUDE_VERSION = '2.1.201';

export function encodeProjectDir(projectPath) {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

const projectsDir = () => path.join(os.homedir(), '.claude', 'projects');
const projectDir = (cwd) => path.join(projectsDir(), encodeProjectDir(cwd));

export function available() {
  return fs.existsSync(path.join(os.homedir(), '.claude'));
}

export function listSessions(cwd) {
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const sessions = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(dir, f);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let title = '', firstPrompt = '';
    for (const l of lines) {
      const o = safeParse(l);
      if (!o) continue;
      if (o.type === 'ai-title') title = o.aiTitle;
      if (!firstPrompt && o.type === 'user' && !o.isMeta && typeof o.message?.content === 'string' && !o.message.content.startsWith('<')) {
        firstPrompt = o.message.content.replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    sessions.push({
      id: f.replace('.jsonl', ''),
      title: title || firstPrompt || '(无标题)',
      updatedAt: fs.statSync(file).mtimeMs,
      count: lines.length,
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Claude 工具名 → 统一词表
function toCanonicalTool(use, output, isError) {
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
    case 'TodoWrite': return { tool: 'todo', input: { todos: (inp.todos || []).map((t) => ({ content: t.content, status: t.status })) } };
    case 'TaskCreate': return { tool: 'todo', input: { todos: [{ content: inp.subject || '', status: 'pending' }] } };
    case 'AskUserQuestion': return {
      tool: 'ask-user',
      input: { questions: (inp.questions || []).map((q) => ({ question: q.question || '', options: (q.options || []).map((o) => o.label) })) },
    };
    case 'Task': case 'Agent': return { tool: 'subagent', input: { prompt: inp.prompt || inp.description || '' } };
    default: return { tool: 'other', input: { name: use.name || 'unknown', args: inp } };
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => b.text || '').join('\n');
  return content == null ? '' : JSON.stringify(content);
}

export function readSession(cwd, sessionId) {
  const file = path.join(projectDir(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`未找到 Claude Code 会话: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => safeParse(l)).filter(Boolean);

  const results = new Map();
  for (const l of lines) {
    if (l.type !== 'user' || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message.content) {
      if (b.type === 'tool_result') results.set(b.tool_use_id, b);
    }
  }

  const events = [];
  const skipped = {};
  let title = '';
  for (const l of lines) {
    const ts = l.timestamp || new Date().toISOString();
    if (l.type === 'ai-title') { title = l.aiTitle; continue; }
    if (l.type === 'user') {
      const c = l.message?.content;
      if (l.isMeta) {
        events.push({ kind: 'marker', ts, text: resultText(c) });
      } else if (typeof c === 'string') {
        events.push({ kind: 'user', ts, text: c });
      } else if (Array.isArray(c)) {
        const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
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
    } else if (l.type && l.type !== 'assistant') {
      skipped[l.type] = (skipped[l.type] || 0) + 1;
    }
  }
  return { title: title || sessionId.slice(0, 8), events, skipped };
}

// ---- 写入 ----

// 统一词表 → Claude 工具名与输入
function fromCanonicalTool(e) {
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
    case 'todo': return { name: 'TodoWrite', input: { todos: i.todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.content })) } };
    case 'ask-user': return {
      name: 'AskUserQuestion',
      input: { questions: i.questions.map((q) => ({ question: q.question, header: q.question.slice(0, 12), options: q.options.map((o) => ({ label: o, description: '' })), multiSelect: false })) },
    };
    case 'subagent': return { name: 'Task', input: { description: '子代理任务', prompt: i.prompt } };
    case 'mcp': return { name: `mcp__${i.server}__${i.toolName}`.replace(/[^a-zA-Z0-9_]/g, '_'), input: i.args };
    default: return { name: String(i.name || 'UnknownTool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'UnknownTool', input: i.args || {} };
  }
}

export function writeReady() {
  return null;
}

export function writeSession(cwd, title, events, meta = {}) {
  const sessionId = randomUUID();
  const model = meta.sourceModel ? `${meta.source || 'import'}/${meta.sourceModel}` : 'agent-connect/import';
  const lines = [];
  let lastUuid = null;
  let lastUserText = '';

  const env = (uuid, ts) => ({
    parentUuid: lastUuid, isSidechain: false, uuid, timestamp: ts,
    userType: 'external', entrypoint: 'cli', cwd, sessionId, version: CLAUDE_VERSION, gitBranch: '',
  });
  const emitUser = (content, ts, extra = {}) => {
    const uuid = randomUUID();
    lines.push({ ...env(uuid, ts), type: 'user', promptId: randomUUID(), message: { role: 'user', content }, origin: { kind: 'human' }, promptSource: 'typed', permissionMode: 'default', ...extra });
    lastUuid = uuid;
    return uuid;
  };
  const emitAssistant = (blocks, ts, stopReason) => {
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
        emitUser(e.text, e.ts);
        lastUserText = e.text;
        break;
      case 'assistant-text':
        emitAssistant([{ type: 'text', text: e.text }], e.ts, 'end_turn');
        break;
      case 'thinking':
        emitAssistant([{ type: 'thinking', thinking: e.text, signature: e.signature || '' }], e.ts, null);
        break;
      case 'marker':
        emitUser([{ type: 'text', text: e.text }], e.ts, { isMeta: true });
        break;
      case 'tool': {
        const { name, input } = fromCanonicalTool(e);
        const toolId = `toolu_migrated_${randomUUID().slice(0, 8)}`;
        const assistantUuid = emitAssistant([{ type: 'tool_use', id: toolId, name, input }], e.ts, 'tool_use');
        const uuid = randomUUID();
        lines.push({
          ...env(uuid, e.ts), type: 'user',
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
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return {
    id: sessionId,
    resumeHint: `claude --resume ${sessionId}  (或在 Claude Code 中 /resume 选择《${title}》)`,
  };
}

export const writeNotes = [
  '思考块原样保留为 thinking 块 (API 忽略历史轮次 thinking, 不影响恢复)',
  'MCP 调用保留完整记录 (目标端未配置同名 MCP 服务器时不可重新调用)',
];
