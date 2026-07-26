// JSONL 适配器 (claude/codex/pi) 的 list/read/write 往返测试
// 适配器在调用时通过 os.homedir() 解析路径; 先覆盖 HOME/USERPROFILE 再动态导入
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalEvent, ToolEvent } from '../src/types.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-home-'));
process.env.USERPROFILE = tempHome; // Windows 下 os.homedir() 读 USERPROFILE
process.env.HOME = tempHome; // POSIX 下读 HOME

const claude = await import('../src/adapters/claude.ts');
const codex = await import('../src/adapters/codex.ts');
const pi = await import('../src/adapters/pi.ts');

const restoreEnv = (key: 'HOME' | 'USERPROFILE', value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterAll(() => {
  restoreEnv('HOME', ORIGINAL_HOME);
  restoreEnv('USERPROFILE', ORIGINAL_USERPROFILE);
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const projectCwd = path.join(tempHome, 'work', 'proj');
const TS = '2026-07-26T10:00:00.000Z';

// 写入测试共用的统一事件流
const canonicalEvents: CanonicalEvent[] = [
  { kind: 'user', ts: TS, text: 'hello there' },
  { kind: 'assistant-text', ts: TS, text: 'general reply' },
  { kind: 'tool', ts: TS, tool: 'terminal', input: { command: 'echo hi' }, output: 'hi', isError: false },
];

const writeJsonl = (file: string, records: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
};

const readJsonl = (file: string): Record<string, any>[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('os.homedir() follows the USERPROFILE/HOME override', () => {
  expect(os.homedir()).toBe(tempHome);
});

// ---- Claude Code ----

describe('claude adapter', () => {
  const sessionId = randomUUID();
  const sessionDir = path.join(tempHome, '.claude', 'projects', claude.encodeProjectDir(projectCwd));
  writeJsonl(path.join(sessionDir, `${sessionId}.jsonl`), [
    { type: 'user', timestamp: TS, message: { role: 'user', content: 'hello claude' } },
    { type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
    { type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixture_1', name: 'Bash', input: { command: 'echo hi' } }] } },
    { type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture_1', content: 'hi' }] } },
  ]);

  test('listSessions finds the fixture with the first prompt as title', () => {
    const sessions = claude.listSessions(projectCwd);
    const found = sessions.find((s: { id: string }) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('hello claude');
  });

  test('readSession yields the canonical event sequence with joined tool output', () => {
    const { events, skipped } = claude.readSession(projectCwd, sessionId);
    expect(events.map((e: CanonicalEvent) => e.kind)).toEqual(['user', 'assistant-text', 'tool']);
    expect(events[0]).toMatchObject({ kind: 'user', text: 'hello claude' });
    expect(events[1]).toMatchObject({ kind: 'assistant-text', text: 'hi there' });
    const tool = events[2] as ToolEvent;
    expect(tool.tool).toBe('terminal');
    expect(tool.input.command).toBe('echo hi');
    expect(tool.output).toBe('hi'); // tool_result 已并入调用事件
    expect(tool.isError).toBe(false);
    expect(skipped).toEqual({});
  });

  test('writeSession produces valid JSONL with ai-title and paired tool_use/tool_result', () => {
    const written = claude.writeSession(projectCwd, 'migrated title', canonicalEvents, { source: 'pi' });
    const lines = readJsonl(path.join(sessionDir, `${written.id}.jsonl`)); // 每行都能 JSON.parse

    const titleLine = lines.find((l) => l.type === 'ai-title');
    expect(titleLine).toBeDefined();
    expect(titleLine!.aiTitle).toBe('migrated title');

    const useIndex = lines.findIndex((l) => l.type === 'assistant' && l.message?.content?.[0]?.type === 'tool_use');
    expect(useIndex).toBeGreaterThan(-1);
    const use = lines[useIndex]!.message.content[0];
    expect(use.name).toBe('Bash');
    const result = lines[useIndex + 1]!;
    expect(result.type).toBe('user');
    expect(result.message.content[0].type).toBe('tool_result');
    expect(result.message.content[0].tool_use_id).toBe(use.id);
  });

  test('claude→claude round trip preserves canonical events', () => {
    const written = claude.writeSession(projectCwd, 'round trip', canonicalEvents);
    const { title, events } = claude.readSession(projectCwd, written.id);
    expect(title).toBe('round trip');
    expect(events.filter((e: CanonicalEvent) => e.kind === 'user').map((e: any) => e.text)).toEqual(['hello there']);
    expect(events.filter((e: CanonicalEvent) => e.kind === 'assistant-text').map((e: any) => e.text)).toEqual(['general reply']);
    const tool = events.find((e: CanonicalEvent) => e.kind === 'tool') as ToolEvent;
    expect(tool.tool).toBe('terminal');
    expect(tool.input.command).toBe('echo hi');
    expect(tool.output).toBe('hi');
  });
});

// ---- Codex CLI ----

describe('codex adapter', () => {
  const sessionId = randomUUID();
  const fixtureFile = path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-00-${sessionId}.jsonl`);
  writeJsonl(fixtureFile, [
    { timestamp: TS, type: 'session_meta', payload: { session_id: sessionId, id: sessionId, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'list files please' } },
    { timestamp: TS, type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'sure' }] } },
    { timestamp: TS, type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }), call_id: 'call_1' } },
    { timestamp: TS, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'file-a\nfile-b' } },
  ]);

  test('listSessions matches on session_meta cwd and titles from the first user message', () => {
    const sessions = codex.listSessions(projectCwd);
    const found = sessions.find((s: { id: string }) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('list files please');
    expect(codex.listSessions(path.join(tempHome, 'other', 'proj'))).toEqual([]);
  });

  test('readSession converts the array shell command to a string and joins outputs', () => {
    const { title, events, skipped } = codex.readSession(projectCwd, sessionId);
    expect(title).toBe('list files please');
    expect(events.map((e: CanonicalEvent) => e.kind)).toEqual(['user', 'assistant-text', 'tool']);
    expect(events[0]).toMatchObject({ kind: 'user', text: 'list files please' });
    expect(events[1]).toMatchObject({ kind: 'assistant-text', text: 'sure' });
    const tool = events[2] as ToolEvent;
    expect(tool.tool).toBe('terminal');
    expect(tool.input.command).toBe('ls'); // ["bash","-lc","ls"] → "ls"
    expect(tool.output).toBe('file-a\nfile-b'); // function_call_output 已并入
    expect(skipped).toEqual({});
  });

  test('session lookup resolves a partial uuid prefix', () => {
    const { title } = codex.readSession(projectCwd, sessionId.slice(0, 8));
    expect(title).toBe('list files please');
  });

  test('writeSession leads with session_meta carrying cwd and originator agent-connect', () => {
    const written = codex.writeSession(projectCwd, 'codex migrated', canonicalEvents);
    // 按返回 id 定位写出的 rollout 文件
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.includes(written.id)) files.push(p);
      }
    };
    walk(path.join(tempHome, '.codex', 'sessions'));
    expect(files.length).toBe(1);

    const lines = readJsonl(files[0]!);
    expect(lines[0]!.type).toBe('session_meta');
    expect(lines[0]!.payload.cwd).toBe(projectCwd);
    expect(lines[0]!.payload.originator).toBe('agent-connect');
    expect(lines[0]!.payload.model_provider).toBe('openai'); // 取自真实会话模板

    // 写出的会话可再读回, 事件语义保留
    const { events } = codex.readSession(projectCwd, written.id);
    expect(events.filter((e: CanonicalEvent) => e.kind === 'user').map((e: any) => e.text)).toEqual(['hello there']);
    const tool = events.find((e: CanonicalEvent) => e.kind === 'tool') as ToolEvent;
    expect(tool.input.command).toBe('echo hi');
    expect(tool.output).toBe('hi');
  });
});

// ---- Pi ----

describe('pi adapter', () => {
  const sessionId = randomUUID();
  // 与 src/adapters/pi.ts 的目录编码保持一致: --<去掉开头斜杠, [/\:] → ->--
  const encoded = `--${projectCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = path.join(tempHome, '.pi', 'agent', 'sessions', encoded);
  writeJsonl(path.join(sessionDir, `2026-07-26T10-00-00-000Z_${sessionId}.jsonl`), [
    { type: 'session', version: 3, id: sessionId, timestamp: TS, cwd: projectCwd },
    { type: 'session_info', name: 'pi fixture session', id: 'e1', parentId: null, timestamp: TS },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'hello pi' }] } },
    { type: 'message', id: 'e3', parentId: 'e2', timestamp: TS, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'hi from pi' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'pwd' } }] } },
    { type: 'message', id: 'e4', parentId: 'e3', timestamp: TS, message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: '/work' }], isError: false } },
  ]);

  test('listSessions finds the fixture titled from session_info', () => {
    const sessions = pi.listSessions(projectCwd);
    const found = sessions.find((s: { id: string }) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('pi fixture session');
  });

  test('readSession yields the canonical event sequence with joined tool output', () => {
    const { title, events } = pi.readSession(projectCwd, sessionId);
    expect(title).toBe('pi fixture session');
    expect(events.map((e: CanonicalEvent) => e.kind)).toEqual(['user', 'assistant-text', 'tool']);
    expect(events[0]).toMatchObject({ kind: 'user', text: 'hello pi' });
    expect(events[1]).toMatchObject({ kind: 'assistant-text', text: 'hi from pi' });
    const tool = events[2] as ToolEvent;
    expect(tool.tool).toBe('terminal');
    expect(tool.input.command).toBe('pwd');
    expect(tool.output).toBe('/work');
  });

  test('readSession for a missing project dir throws 未找到, not ENOENT', () => {
    expect(() => pi.readSession(path.join(tempHome, 'nope', 'missing'), sessionId)).toThrow(/未找到 Pi 会话/);
  });

  test('writeSession leads with a v3 session header and keeps the parentId chain consistent', () => {
    const written = pi.writeSession(projectCwd, 'pi migrated', canonicalEvents);
    const file = fs.readdirSync(sessionDir).map((f) => path.join(sessionDir, f)).find((f) => f.endsWith(`_${written.id}.jsonl`));
    expect(file).toBeDefined();
    const lines = readJsonl(file!);

    expect(lines[0]).toMatchObject({ type: 'session', version: 3, id: written.id, cwd: projectCwd });
    expect(lines[1]!.type).toBe('session_info');
    expect(lines[1]!.name).toBe('pi migrated');
    expect(lines[1]!.parentId).toBeNull();
    for (let i = 2; i < lines.length; i++) {
      expect(lines[i]!.parentId).toBe(lines[i - 1]!.id); // 链式 parentId
    }
  });
});
