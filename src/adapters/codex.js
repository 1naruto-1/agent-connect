// Codex CLI 适配器: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// 恢复: codex resume <session-id>
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safeParse, canonicalToolFromName } from '../events.js';

export const id = 'codex';
export const label = 'Codex CLI';

const sessionsDir = () => path.join(os.homedir(), '.codex', 'sessions');

export function available() {
  return fs.existsSync(sessionsDir());
}

function allSessionFiles() {
  const root = sessionsDir();
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.startsWith('rollout-') && f.name.endsWith('.jsonl')) files.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

function readMeta(file) {
  // 首行是 session_meta (内嵌完整系统提示词, 可达数十 KB)
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(262144);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const text = buf.toString('utf8', 0, n);
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const meta = safeParse(firstLine);
  return meta?.type === 'session_meta' ? meta.payload : null;
}

const normPath = (p) => String(p || '').replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');

export function listSessions(cwd) {
  const target = normPath(cwd);
  const sessions = [];
  for (const file of allSessionFiles()) {
    const meta = readMeta(file);
    if (!meta || normPath(meta.cwd) !== target) continue;
    // 标题取第一条用户消息
    let title = '';
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const o = safeParse(line);
      if (o?.type === 'event_msg' && o.payload?.type === 'user_message') {
        title = String(o.payload.message || '').replace(/\s+/g, ' ').slice(0, 60);
        break;
      }
    }
    sessions.push({ id: meta.session_id || meta.id, title: title || '(无标题)', updatedAt: fs.statSync(file).mtimeMs, file });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

function findSessionFile(sessionId) {
  for (const file of allSessionFiles()) {
    if (file.includes(sessionId)) return file;
  }
  throw new Error(`未找到 Codex 会话: ${sessionId}`);
}

// custom_tool_call 的 input 是 JS 脚本, 尝试提取 shell 命令
function extractShellCommand(script) {
  const m = String(script || '').match(/shell_command\(\{command:\s*("(?:[^"\\]|\\.)*")/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  return null;
}

const itemText = (content) => (Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : String(content ?? ''));

export function readSession(cwd, sessionId) {
  const file = findSessionFile(sessionId);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => safeParse(l)).filter(Boolean);

  const events = [];
  const skipped = {};
  let title = '';
  // 先收集工具输出 (call_id → output)
  const outputs = new Map();
  for (const l of lines) {
    const p = l.payload;
    if (l.type === 'response_item' && (p?.type === 'custom_tool_call_output' || p?.type === 'function_call_output')) {
      outputs.set(p.call_id, itemText(p.output));
    }
  }

  for (const l of lines) {
    const ts = l.timestamp || new Date().toISOString();
    const p = l.payload;
    if (l.type === 'event_msg' && p?.type === 'user_message') {
      if (!title) title = String(p.message || '').replace(/\s+/g, ' ').slice(0, 60);
      events.push({ kind: 'user', ts, text: p.message || '' });
    } else if (l.type === 'response_item') {
      switch (p?.type) {
        case 'message':
          if (p.role === 'assistant') events.push({ kind: 'assistant-text', ts, text: itemText(p.content) });
          // role user 的 response_item 是注入的环境上下文, user_message 事件已覆盖真实输入
          else skipped[`注入消息(${p.role})`] = (skipped[`注入消息(${p.role})`] || 0) + 1;
          break;
        case 'reasoning': {
          const text = (p.summary || []).map((s) => s.text || '').join('\n');
          if (text) events.push({ kind: 'thinking', ts, text, signature: '' });
          break;
        }
        case 'custom_tool_call': {
          const command = extractShellCommand(p.input);
          const output = outputs.get(p.call_id) ?? '';
          if (command) events.push({ kind: 'tool', ts, tool: 'terminal', input: { command }, output, isError: /Script failed|error/i.test(output.slice(0, 100)), origName: p.name });
          else events.push({ kind: 'tool', ts, tool: 'other', input: { name: p.name || 'exec', args: { script: p.input } }, output, isError: false, origName: p.name });
          break;
        }
        case 'function_call': {
          const args = safeParse(p.arguments) || {};
          const output = outputs.get(p.call_id) ?? '';
          const canonical = canonicalToolFromName(p.name, args);
          if (canonical) events.push({ kind: 'tool', ts, ...canonical, output, isError: false, origName: p.name });
          else events.push({ kind: 'tool', ts, tool: 'other', input: { name: p.name || 'function', args }, output, isError: false, origName: p.name });
          break;
        }
        case 'custom_tool_call_output': case 'function_call_output':
          break; // 已合并进调用事件
        default:
          skipped[`response_item:${p?.type}`] = (skipped[`response_item:${p?.type}`] || 0) + 1;
      }
    } else if (l.type === 'compacted') {
      events.push({ kind: 'marker', ts, text: '[Codex 曾在此处压缩上下文]' });
    } else if (l.type !== 'session_meta') {
      // event_msg 的 agent_message/agent_reasoning 与 response_item 重复, 其余为 UI/统计事件
      const key = l.type === 'event_msg' ? `event:${p?.type}` : l.type;
      if (!['event:agent_message', 'event:agent_reasoning'].includes(key)) skipped[key] = (skipped[key] || 0) + 1;
    }
  }
  return { title: title || sessionId.slice(0, 8), events, skipped };
}

// ---- 写入 ----

// uuid v7 风格 (时间戳前缀), 与 codex 会话 id 格式一致
function uuidV7(ms = Date.now()) {
  const hex = ms.toString(16).padStart(12, '0');
  const rand = randomUUID().replaceAll('-', '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16)}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

export function writeReady() {
  return null;
}

// 取最近一个真实 codex 会话作为配置模板 (model_provider/base_instructions/turn_context)
// TUI resume 会从 rollout 恢复线程配置, 缺 model_provider 会报 "Model provider `` not found"
function configTemplate() {
  const files = allSessionFiles().map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
  for (const { f } of files) {
    const meta = readMeta(f);
    if (!meta || meta.originator === 'agent-connect' || !meta.model_provider) continue;
    let turnContext = null;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const o = safeParse(line);
      if (o?.type === 'turn_context') { turnContext = o.payload; break; }
    }
    return { modelProvider: meta.model_provider, baseInstructions: meta.base_instructions, cliVersion: meta.cli_version, turnContext };
  }
  return { modelProvider: 'openai', baseInstructions: undefined, cliVersion: '0.144.6', turnContext: null };
}

export function writeSession(cwd, title, events) {
  const now = new Date();
  const sessionId = uuidV7(now.getTime());
  const iso = now.toISOString();
  const tpl = configTemplate();
  const lines = [];
  const push = (type, payload, ts) => lines.push({ timestamp: ts, type, payload });

  push('session_meta', {
    session_id: sessionId, id: sessionId, timestamp: iso, cwd,
    originator: 'agent-connect', cli_version: tpl.cliVersion, source: 'cli', thread_source: 'user',
    model_provider: tpl.modelProvider,
    ...(tpl.baseInstructions ? { base_instructions: tpl.baseInstructions } : {}),
  }, iso);
  if (tpl.turnContext) {
    push('turn_context', {
      ...tpl.turnContext,
      turn_id: uuidV7(now.getTime()),
      cwd, workspace_roots: [cwd],
      current_date: iso.slice(0, 10),
    }, iso);
  }

  // 真实 rollout 中助手内容在两条流各写一份: response_item(模型上下文) + event_msg(TUI 显示)
  const msgId = () => `msg_${randomUUID().replaceAll('-', '')}`;
  const userMsg = (text, ts) => {
    push('event_msg', { type: 'user_message', message: text, images: [], local_images: [], text_elements: [] }, ts);
    push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ts);
  };
  const assistantMsg = (text, phase, ts) => {
    push('response_item', { type: 'message', id: msgId(), role: 'assistant', content: [{ type: 'output_text', text }], phase }, ts);
    push('event_msg', { type: 'agent_message', message: text, phase, memory_citation: null }, ts);
  };

  for (const e of events) {
    switch (e.kind) {
      case 'user':
        userMsg(e.text, e.ts);
        break;
      case 'marker':
        userMsg(e.text, e.ts);
        break;
      case 'assistant-text':
        assistantMsg(e.text, 'final_answer', e.ts);
        break;
      case 'thinking':
        // Codex reasoning 是加密内容无法构造; 思考文本以 commentary 消息保留 (上下文与显示都有)
        assistantMsg(`[思考过程]\n${e.text}`, 'commentary', e.ts);
        break;
      case 'tool': {
        const callId = `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
        const name = e.tool === 'terminal' ? 'shell' : e.tool === 'other' ? String(e.input.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_') : e.tool.replace(/-/g, '_');
        const args = e.tool === 'terminal' ? { command: e.input.command } : e.tool === 'other' ? e.input.args : e.input;
        push('response_item', { type: 'function_call', id: `fc_${callId}`, name, arguments: JSON.stringify(args), call_id: callId }, e.ts);
        push('response_item', { type: 'function_call_output', call_id: callId, output: [{ type: 'input_text', text: e.output ?? '' }] }, e.ts);
        break;
      }
    }
  }

  // 按 codex 目录规则写入: sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
  const dir = path.join(sessionsDir(), String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const tsName = iso.slice(0, 19).replaceAll(':', '-');
  const file = path.join(dir, `rollout-${tsName}-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { id: sessionId, resumeHint: `codex resume ${sessionId}` };
}

export const writeNotes = [
  '思考块转为带 [思考过程] 前缀的助手消息 (Codex 的 reasoning 为加密格式, 无法直接构造)',
  '工具调用转为 function_call/function_call_output 对, 终端命令映射为 shell',
];
