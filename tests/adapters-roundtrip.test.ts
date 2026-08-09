// JSONL 适配器 (claude/codex/pi) 的 list/read/write 往返测试
// 适配器在调用时通过 homeDirectory() (环境变量优先) 解析路径; 先覆盖 HOME/USERPROFILE 再导入
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalEvent, ToolEvent } from '../src/types.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-home-'));
process.env.USERPROFILE = tempHome; // win32 下 homeDirectory() 读 USERPROFILE
process.env.HOME = tempHome; // POSIX 下读 HOME

const { homeDirectory } = await import('../src/platform/paths.ts');
const claude = await import('../src/adapters/claude.ts');
const codex = await import('../src/adapters/codex.ts');
const pi = await import('../src/adapters/pi.ts');
const { buildSessionPath } = await import('../src/adapters/pi-session.ts');
const { applyThreadRollbacks, userTurnBoundaries } = await import('../src/adapters/codex-session.ts');

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

test('homeDirectory() follows the USERPROFILE/HOME override', () => {
  expect(homeDirectory()).toBe(tempHome);
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

  // 没有 ai-title 时, 迁移写入目标 Harness 的名称必须与列表显示一致, 而不是退化成会话 id
  test('readSession inherits the first prompt when ai-title is absent', () => {
    expect(claude.readSession(projectCwd, sessionId).title).toBe('hello claude');
  });

  test('readSession prefers ai-title over the first prompt', () => {
    const titled = randomUUID();
    writeJsonl(path.join(sessionDir, `${titled}.jsonl`), [
      { type: 'user', timestamp: TS, message: { role: 'user', content: 'first prompt' } },
      { type: 'ai-title', aiTitle: 'harness generated title', sessionId: titled },
    ]);
    expect(claude.readSession(projectCwd, titled).title).toBe('harness generated title');
    expect(claude.listSessions(projectCwd).find((s: { id: string }) => s.id === titled)!.title).toBe('harness generated title');
  });

  test('readSession names the harness when only slash-command wrappers exist', () => {
    const wrapped = randomUUID();
    writeJsonl(path.join(sessionDir, `${wrapped}.jsonl`), [
      { type: 'user', timestamp: TS, message: { role: 'user', content: '<command-name>/model</command-name>' } },
    ]);
    expect(claude.readSession(projectCwd, wrapped).title).toBe(`Claude Code 会话 ${wrapped.slice(0, 8)}`);
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

    // Claude loader 在时间相同时选首条记录; 写入端必须让每条 transcript 记录严格递增。
    const transcript = readJsonl(path.join(sessionDir, `${written.id}.jsonl`)).filter((line) => typeof line.uuid === 'string');
    for (let i = 1; i < transcript.length; i++) {
      expect(Date.parse(transcript[i]!.timestamp)).toBeGreaterThan(Date.parse(transcript[i - 1]!.timestamp));
    }
    let nativeLeaf = transcript[0]!;
    for (const line of transcript.slice(1)) {
      if (Date.parse(line.timestamp) > Date.parse(nativeLeaf.timestamp)) nativeLeaf = line;
    }
    expect(nativeLeaf.uuid).toBe(transcript[transcript.length - 1]!.uuid);
  });

  test('readSession keeps the first record when timestamps tie, as Claude does', () => {
    const tied = randomUUID();
    const u1 = randomUUID(), a1 = randomUUID(), u2 = randomUUID();
    writeJsonl(path.join(sessionDir, `${tied}.jsonl`), [
      { type: 'user', uuid: u1, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'first question' } },
      { type: 'assistant', uuid: a1, parentUuid: u1, isSidechain: false, timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
      { type: 'user', uuid: u2, parentUuid: a1, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'later question' } },
    ]);
    const { events } = claude.readSession(projectCwd, tied);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'first question'],
    ]);
  });

  // JSONL 是 parentUuid 树; 与 Claude --resume 一致, 只迁移「最近非 sidechain leaf → 根」的活跃链
  test('readSession follows the active parentUuid branch and skips abandoned forks', () => {
    const branched = randomUUID();
    const u1 = randomUUID(), a1 = randomUUID(), u2 = randomUUID(), a2 = randomUUID(), u3 = randomUUID(), a3 = randomUUID();
    writeJsonl(path.join(sessionDir, `${branched}.jsonl`), [
      { type: 'user', uuid: u1, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'first question' } },
      { type: 'assistant', uuid: a1, parentUuid: u1, isSidechain: false, timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
      // 废弃分支
      { type: 'user', uuid: u2, parentUuid: a1, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'abandoned question' } },
      { type: 'assistant', uuid: a2, parentUuid: u2, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned answer' }] } },
      // 从 a1 重试, 时间更新 → 成为 leaf
      { type: 'user', uuid: u3, parentUuid: a1, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z', message: { role: 'user', content: 'retried question' } },
      { type: 'assistant', uuid: a3, parentUuid: u3, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } },
    ]);
    const { events, skipped } = claude.readSession(projectCwd, branched);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'first question'],
      ['assistant-text', 'first answer'],
      ['user', 'retried question'],
      ['assistant-text', 'final answer'],
    ]);
    expect(skipped['已废弃分支']).toBe(2);
  });

  test('readSession prefers custom-title over ai-title', () => {
    const titled = randomUUID();
    writeJsonl(path.join(sessionDir, `${titled}.jsonl`), [
      { type: 'user', timestamp: TS, message: { role: 'user', content: 'first prompt' } },
      { type: 'ai-title', aiTitle: 'ai generated', sessionId: titled },
      { type: 'custom-title', customTitle: 'user renamed', sessionId: titled },
    ]);
    expect(claude.readSession(projectCwd, titled).title).toBe('user renamed');
    expect(claude.listSessions(projectCwd).find((s: { id: string }) => s.id === titled)!.title).toBe('user renamed');
  });

  test('readSession lets an empty custom-title clear an older ai-title', () => {
    const cleared = randomUUID();
    writeJsonl(path.join(sessionDir, `${cleared}.jsonl`), [
      { type: 'user', timestamp: TS, message: { role: 'user', content: 'fallback prompt' } },
      { type: 'ai-title', aiTitle: 'stale ai title', sessionId: cleared },
      { type: 'custom-title', customTitle: '', sessionId: cleared },
    ]);
    expect(claude.readSession(projectCwd, cleared).title).toBe('fallback prompt');
    expect(claude.listSessions(projectCwd).find((s: { id: string }) => s.id === cleared)!.title).toBe('fallback prompt');
  });

  test('readSession keeps compact_boundary as a marker on the active chain', () => {
    const compacted = randomUUID();
    const u1 = randomUUID(), boundary = randomUUID(), u2 = randomUUID();
    writeJsonl(path.join(sessionDir, `${compacted}.jsonl`), [
      { type: 'user', uuid: u1, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'before compact' } },
      {
        type: 'system', uuid: boundary, parentUuid: null, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z',
        subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: { trigger: 'manual', preTokens: 1000, messagesSummarized: 12 },
      },
      { type: 'user', uuid: u2, parentUuid: boundary, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'user', content: 'after compact' } },
    ]);
    const { events } = claude.readSession(projectCwd, compacted);
    expect(events.map((e: CanonicalEvent) => e.kind)).toEqual(['marker', 'user']);
    expect((events[0] as any).text).toContain('12');
    expect((events[1] as any).text).toBe('after compact');
  });

  test('readSession keeps history when the latest preservedSegment is incomplete', () => {
    const partial = randomUUID();
    const u0 = randomUUID(), firstBoundary = randomUUID(), u1 = randomUUID(), latestBoundary = randomUUID(), u2 = randomUUID();
    writeJsonl(path.join(sessionDir, `${partial}.jsonl`), [
      { type: 'user', uuid: u0, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'keep root' } },
      {
        type: 'system', uuid: firstBoundary, parentUuid: u0, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z',
        subtype: 'compact_boundary', compactMetadata: { preservedSegment: { headUuid: u0, tailUuid: u0, anchorUuid: u0 } },
      },
      { type: 'user', uuid: u1, parentUuid: firstBoundary, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'user', content: 'keep middle' } },
      {
        type: 'system', uuid: latestBoundary, parentUuid: u1, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', compactMetadata: { preservedSegment: { headUuid: u1, tailUuid: u1 } },
      },
      { type: 'user', uuid: u2, parentUuid: latestBoundary, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', message: { role: 'user', content: 'keep latest' } },
    ]);
    const { events } = claude.readSession(projectCwd, partial);
    expect(events.filter((e: CanonicalEvent) => e.kind === 'user').map((e: any) => e.text)).toEqual([
      'keep root', 'keep middle', 'keep latest',
    ]);
  });

  test('readSession keeps history when the preserved tail cannot reach its head', () => {
    const broken = randomUUID();
    const root = randomUUID(), wrongHead = randomUUID(), tail = randomUUID(), boundary = randomUUID(), after = randomUUID();
    writeJsonl(path.join(sessionDir, `${broken}.jsonl`), [
      { type: 'user', uuid: root, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'keep root' } },
      { type: 'user', uuid: wrongHead, parentUuid: root, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'different branch' } },
      { type: 'assistant', uuid: tail, parentUuid: root, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'keep tail' }] } },
      {
        type: 'system', uuid: boundary, parentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', compactMetadata: { preservedSegment: { headUuid: wrongHead, tailUuid: tail, anchorUuid: root } },
      },
      { type: 'user', uuid: after, parentUuid: boundary, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', message: { role: 'user', content: 'keep after' } },
    ]);
    const { events } = claude.readSession(projectCwd, broken);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'keep root'],
      ['assistant-text', 'keep tail'],
      ['marker', '[Claude Code 曾在此处压缩上下文]'],
      ['user', 'keep after'],
    ]);
  });

  // snip 在构建活跃链之前应用; 完整流水线顺序是 compact relink → snip (见 effectiveTranscript)
  test('readSession applies snipMetadata removals before building the chain', () => {
    const snipped = randomUUID();
    const u1 = randomUUID(), a1 = randomUUID(), u2 = randomUUID(), a2 = randomUUID(), u3 = randomUUID(), boundary = randomUUID();
    writeJsonl(path.join(sessionDir, `${snipped}.jsonl`), [
      { type: 'user', uuid: u1, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'keep start' } },
      { type: 'assistant', uuid: a1, parentUuid: u1, isSidechain: false, timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'kept reply' }] } },
      { type: 'user', uuid: u2, parentUuid: a1, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'snip me' } },
      { type: 'assistant', uuid: a2, parentUuid: u2, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'snipped reply' }] } },
      { type: 'user', uuid: u3, parentUuid: a2, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z', message: { role: 'user', content: 'after snip' } },
      {
        type: 'system', uuid: boundary, parentUuid: u3, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z',
        subtype: 'snip_boundary', snipMetadata: { removedUuids: [u2, a2] },
      },
    ]);
    const { events, skipped } = claude.readSession(projectCwd, snipped);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'keep start'],
      ['assistant-text', 'kept reply'],
      ['user', 'after snip'],
    ]);
    expect(skipped['已裁剪消息']).toBe(2);
  });

  // compact 必须先于 snip: 若先 snip 掉 preserved head, compact 无法走通保留段, 会提前返回并留下应被剪掉的旧消息。
  // 使用原生后缀形态: boundary parentUuid:null/logicalParentUuid=tail, 锚点是 boundary 后的 isCompactSummary 摘要
  test('readSession applies preservedSegment compact before snip when both are present', () => {
    const mixed = randomUUID();
    const uOld = randomUUID(), uHead = randomUUID(), aTail = randomUUID();
    const compactBoundary = randomUUID(), uSummary = randomUUID(), uAfter = randomUUID(), uFinal = randomUUID(), snipBoundary = randomUUID();
    writeJsonl(path.join(sessionDir, `${mixed}.jsonl`), [
      { type: 'user', uuid: uOld, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'should be pruned by compact' } },
      { type: 'user', uuid: uHead, parentUuid: uOld, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'preserved head' } },
      { type: 'assistant', uuid: aTail, parentUuid: uHead, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved tail' }] } },
      {
        type: 'system', uuid: compactBoundary, parentUuid: null, logicalParentUuid: aTail, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: {
          trigger: 'manual', preTokens: 2000, messagesSummarized: 1,
          preservedSegment: { headUuid: uHead, tailUuid: aTail, anchorUuid: uSummary },
        },
      },
      { type: 'user', uuid: uSummary, parentUuid: compactBoundary, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', isCompactSummary: true, message: { role: 'user', content: '压缩后的摘要' } },
      { type: 'user', uuid: uAfter, parentUuid: uSummary, isSidechain: false, timestamp: '2026-07-26T10:00:05.000Z', message: { role: 'user', content: 'after compact' } },
      { type: 'user', uuid: uFinal, parentUuid: uAfter, isSidechain: false, timestamp: '2026-07-26T10:00:06.000Z', message: { role: 'user', content: 'after snip' } },
      {
        type: 'system', uuid: snipBoundary, parentUuid: uFinal, isSidechain: false, timestamp: '2026-07-26T10:00:07.000Z',
        subtype: 'snip_boundary', snipMetadata: { removedUuids: [uHead] },
      },
    ]);
    const { events, skipped } = claude.readSession(projectCwd, mixed);
    // compact 把 head 挂回摘要、把 continuation 改挂 tail 并剪掉 uOld; 随后 snip 去掉 preserved head; tail 仍在链上
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['marker', '[Claude Code 曾在此处压缩上下文, 约 1 条消息]'],
      ['user', '压缩后的摘要'],
      ['assistant-text', 'preserved tail'],
      ['user', 'after compact'],
      ['user', 'after snip'],
    ]);
    expect(skipped['已裁剪消息']).toBe(1);
    expect(events.some((e: CanonicalEvent) => (e as any).text === 'should be pruned by compact')).toBe(false);
    expect(events.some((e: CanonicalEvent) => (e as any).text === 'preserved head')).toBe(false);
  });

  // 锚点记录缺失: 保留段元数据齐全且 tail 可达 head, 但 anchorUuid 指向不存在的记录。
  // 旧实现会先重链再裁剪, 剪掉根节点并给 head 挂上空悬父链; 现在校验不过就整体跳过, 完整旧链保留
  test('readSession keeps the full chain when the preserved anchor record is missing', () => {
    const missingAnchor = randomUUID();
    const root = randomUUID(), head = randomUUID(), tail = randomUUID(), boundary = randomUUID(), missing = randomUUID(), later = randomUUID();
    writeJsonl(path.join(sessionDir, `${missingAnchor}.jsonl`), [
      { type: 'user', uuid: root, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'keep root' } },
      { type: 'user', uuid: head, parentUuid: root, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'preserved head' } },
      { type: 'assistant', uuid: tail, parentUuid: head, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved tail' }] } },
      {
        type: 'system', uuid: boundary, parentUuid: null, logicalParentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 2000, messagesSummarized: 3, preservedSegment: { headUuid: head, tailUuid: tail, anchorUuid: missing } },
      },
      { type: 'user', uuid: later, parentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', message: { role: 'user', content: 'keep later' } },
    ]);
    const { events } = claude.readSession(projectCwd, missingAnchor);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'keep root'],
      ['user', 'preserved head'],
      ['assistant-text', 'preserved tail'],
      ['user', 'keep later'],
    ]);
  });

  // 锚点是 boundary 前会被裁剪的普通旧消息 (physical index < boundary): 拒绝重链与裁剪, 完整旧链保留
  test('readSession keeps the full chain when the preserved anchor predates the boundary', () => {
    const badAnchor = randomUUID();
    const anchor = randomUUID(), head = randomUUID(), tail = randomUUID(), boundary = randomUUID(), later = randomUUID();
    writeJsonl(path.join(sessionDir, `${badAnchor}.jsonl`), [
      { type: 'user', uuid: anchor, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'anchor keep' } },
      { type: 'user', uuid: head, parentUuid: anchor, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'preserved head' } },
      { type: 'assistant', uuid: tail, parentUuid: head, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved tail' }] } },
      {
        type: 'system', uuid: boundary, parentUuid: null, logicalParentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 2000, messagesSummarized: 3, preservedSegment: { headUuid: head, tailUuid: tail, anchorUuid: anchor } },
      },
      { type: 'user', uuid: later, parentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', message: { role: 'user', content: 'keep later' } },
    ]);
    const { events } = claude.readSession(projectCwd, badAnchor);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'anchor keep'],
      ['user', 'preserved head'],
      ['assistant-text', 'preserved tail'],
      ['user', 'keep later'],
    ]);
  });

  test('readSession keeps the full chain when the preserved anchor points into the preserved segment', () => {
    const cyclicAnchor = randomUUID();
    const root = randomUUID(), head = randomUUID(), tail = randomUUID(), boundary = randomUUID(), summary = randomUUID(), later = randomUUID();
    writeJsonl(path.join(sessionDir, `${cyclicAnchor}.jsonl`), [
      { type: 'user', uuid: root, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'keep root' } },
      { type: 'user', uuid: head, parentUuid: root, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'preserved head' } },
      { type: 'assistant', uuid: tail, parentUuid: head, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved tail' }] } },
      {
        type: 'system', uuid: boundary, parentUuid: null, logicalParentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 2000, messagesSummarized: 3, preservedSegment: { headUuid: head, tailUuid: tail, anchorUuid: summary } },
      },
      { type: 'user', uuid: summary, parentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', isCompactSummary: true, message: { role: 'user', content: 'invalid summary parent' } },
      { type: 'user', uuid: later, parentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:05.000Z', message: { role: 'user', content: 'keep later' } },
    ]);
    const { events } = claude.readSession(projectCwd, cyclicAnchor);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'keep root'],
      ['user', 'preserved head'],
      ['assistant-text', 'preserved tail'],
      ['user', 'keep later'],
    ]);
  });

  // 原生 compact 前缀形态: anchorUuid 就是 compact boundary 自身 (physical index == boundary),
  // boundary parentUuid:null + logicalParentUuid=tail; relink 后活跃链为 boundary→head→tail→continuation
  test('readSession relinks a prefix-preserving segment anchored at the boundary itself', () => {
    const prefixed = randomUUID();
    const oldRoot = randomUUID(), head = randomUUID(), tail = randomUUID(), boundary = randomUUID(), after = randomUUID();
    writeJsonl(path.join(sessionDir, `${prefixed}.jsonl`), [
      { type: 'user', uuid: oldRoot, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: 'summarized old root' } },
      { type: 'user', uuid: head, parentUuid: oldRoot, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'preserved head' } },
      { type: 'assistant', uuid: tail, parentUuid: head, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved tail' }] } },
      {
        type: 'system', uuid: boundary, parentUuid: null, logicalParentUuid: tail, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 2000, messagesSummarized: 3, preservedSegment: { headUuid: head, tailUuid: tail, anchorUuid: boundary } },
      },
      { type: 'user', uuid: after, parentUuid: boundary, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', message: { role: 'user', content: 'after compact' } },
    ]);
    const { events } = claude.readSession(projectCwd, prefixed);
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['marker', '[Claude Code 曾在此处压缩上下文, 约 3 条消息]'],
      ['user', 'preserved head'],
      ['assistant-text', 'preserved tail'],
      ['user', 'after compact'],
    ]);
    expect(events.some((e: CanonicalEvent) => (e as any).text === 'summarized old root')).toBe(false);
  });

  // 原生 compact 后缀形态: 保留段 (head/tail) 物理上位于 boundary 之前, boundary 之后的
  // isCompactSummary 用户消息是 anchor; relink 把 head 挂回摘要、把摘要的后续子消息改挂 tail。
  // 标题必须取自修剪前的原始提示词, 而不是压缩摘要。
  test('readSession titles a compacted session from the pre-compact prompt, never the summary', () => {
    const compacted = randomUUID();
    const uOld = randomUUID(), uHead = randomUUID(), aTail = randomUUID(), boundary = randomUUID(), uSummary = randomUUID(), uAfter = randomUUID();
    writeJsonl(path.join(sessionDir, `${compacted}.jsonl`), [
      { type: 'user', uuid: uOld, parentUuid: null, isSidechain: false, timestamp: TS, message: { role: 'user', content: '最初的真实问题' } },
      { type: 'user', uuid: uHead, parentUuid: uOld, isSidechain: false, timestamp: '2026-07-26T10:00:01.000Z', message: { role: 'user', content: 'preserved head' } },
      { type: 'assistant', uuid: aTail, parentUuid: uHead, isSidechain: false, timestamp: '2026-07-26T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'preserved tail' }] } },
      {
        type: 'system', uuid: boundary, parentUuid: null, logicalParentUuid: aTail, isSidechain: false, timestamp: '2026-07-26T10:00:03.000Z',
        subtype: 'compact_boundary', content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 5000, messagesSummarized: 8, preservedSegment: { headUuid: uHead, tailUuid: aTail, anchorUuid: uSummary } },
      },
      { type: 'user', uuid: uSummary, parentUuid: boundary, isSidechain: false, timestamp: '2026-07-26T10:00:04.000Z', isCompactSummary: true, message: { role: 'user', content: '此前 8 条消息的压缩摘要, 不应成为标题' } },
      { type: 'user', uuid: uAfter, parentUuid: uSummary, isSidechain: false, timestamp: '2026-07-26T10:00:05.000Z', message: { role: 'user', content: '压缩后的后续问题' } },
    ]);
    const { title, events, skipped } = claude.readSession(projectCwd, compacted);
    expect(title).toBe('最初的真实问题');
    expect(claude.listSessions(projectCwd).find((s: { id: string }) => s.id === compacted)!.title).toBe('最初的真实问题');
    // 摘要仍是规范 user 事件 (上下文), 但绝不能成为标题
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['marker', '[Claude Code 曾在此处压缩上下文, 约 8 条消息]'],
      ['user', '此前 8 条消息的压缩摘要, 不应成为标题'],
      ['user', 'preserved head'],
      ['assistant-text', 'preserved tail'],
      ['user', '压缩后的后续问题'],
    ]);
    // 旧提示已被 compact 剪出活跃链, 只影响标题选择, 事件流里不应再出现
    expect(events.some((e: CanonicalEvent) => (e as any).text === '最初的真实问题')).toBe(false);
    expect(skipped).toEqual({});
  });

  // 数组内容逐块独立判定: IDE/包装文本块可被跳过, 后面的真实提示词块成为标题
  test('readSession titles from the first meaningful text block of array content', () => {
    const arrayTitle = randomUUID();
    writeJsonl(path.join(sessionDir, `${arrayTitle}.jsonl`), [
      { type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: '<command-name>/model</command-name>' }, { type: 'text', text: '真正要问的问题' }] } },
      { type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } },
    ]);
    expect(claude.readSession(projectCwd, arrayTitle).title).toBe('真正要问的问题');
    expect(claude.listSessions(projectCwd).find((s: { id: string }) => s.id === arrayTitle)!.title).toBe('真正要问的问题');
  });

  // 只有包装/元信息/压缩摘要时, 不得把摘要当标题: 列表保持 (无标题), 读取用 harness 兜底
  test('readSession never titles from compact summaries or wrappers', () => {
    const summaryOnly = randomUUID();
    writeJsonl(path.join(sessionDir, `${summaryOnly}.jsonl`), [
      { type: 'user', timestamp: TS, message: { role: 'user', content: '<command-name>/init</command-name>' } },
      { type: 'user', timestamp: TS, isCompactSummary: true, message: { role: 'user', content: '之前工作的压缩摘要' } },
      { type: 'user', timestamp: TS, isMeta: true, message: { role: 'user', content: '元信息' } },
    ]);
    expect(claude.readSession(projectCwd, summaryOnly).title).toBe(`Claude Code 会话 ${summaryOnly.slice(0, 8)}`);
    expect(claude.listSessions(projectCwd).find((s: { id: string }) => s.id === summaryOnly)!.title).toBe('(无标题)');
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

  // 链式迁移: 上一跳写入的来源说明是普通用户消息, 不能被当成标题继续传下去
  test('readSession skips the agent-connect provenance marker when titling', () => {
    const chained = randomUUID();
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-01-${chained}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: chained, id: chained, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: '[agent-connect] 本会话由 Claude Code 会话《abc》迁移而来。' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: '真正的问题' } },
    ]);
    expect(codex.readSession(projectCwd, chained).title).toBe('真正的问题');
    expect(codex.listSessions(projectCwd).find((s: { id: string }) => s.id === chained)!.title).toBe('真正的问题');
  });

  test('session lookup resolves a partial uuid prefix', () => {
    const { title } = codex.readSession(projectCwd, sessionId.slice(0, 8));
    expect(title).toBe('list files please');
  });

  // 与 Codex resume 一致丢弃已回退轮次; 切点用 event_msg (双轨里的 response_item role=user 不计入边界)
  test('readSession drops turns removed by thread_rolled_back', () => {
    const rolled = randomUUID();
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-02-${rolled}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: rolled, id: rolled, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep this turn' }] } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'keep this turn' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept answer' }] } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abandon this turn' }] } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'abandon this turn' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'abandoned answer' }] } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retry after rollback' }] } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'retry after rollback' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final answer' }] } },
    ]);
    const { events, skipped } = codex.readSession(projectCwd, rolled);
    expect(events.map((e: any) => [e.kind, e.text])).toEqual([
      ['user', 'keep this turn'],
      ['assistant-text', 'kept answer'],
      ['user', 'retry after rollback'],
      ['assistant-text', 'final answer'],
    ]);
    expect(skipped['已回退轮次']).toBe(1);
    expect(skipped['注入消息(user)']).toBeUndefined();
  });

  // 分页 history_mode 用 item_completed(UserMessage) 代替 legacy user_message
  test('readSession accepts paginated item_completed UserMessage events', () => {
    const paged = randomUUID();
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-03-${paged}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: paged, id: paged, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai', history_mode: 'paginated' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'paginated hello' }] } },
      {
        timestamp: TS,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: paged,
          turn_id: 'turn-1',
          item: { type: 'UserMessage', id: 'user-1', content: [{ type: 'text', text: 'paginated hello' }] },
        },
      },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'paginated reply' }] } },
    ]);
    const { title, events } = codex.readSession(projectCwd, paged);
    expect(title).toBe('paginated hello');
    expect(events.map((e: any) => [e.kind, e.text])).toEqual([
      ['user', 'paginated hello'],
      ['assistant-text', 'paginated reply'],
    ]);
    expect(codex.listSessions(projectCwd).find((s: { id: string }) => s.id === paged)!.title).toBe('paginated hello');
  });

  test('readSession supports historical writer-order event->response user turns', () => {
    const writerOrdered = randomUUID();
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-06-${writerOrdered}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: writerOrdered, id: writerOrdered, timestamp: TS, cwd: projectCwd, originator: 'agent-connect', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'writer order prompt' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'writer order prompt' }] } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'writer order answer' }] } },
    ]);
    const { title, events, skipped } = codex.readSession(projectCwd, writerOrdered);
    expect(title).toBe('writer order prompt');
    expect(events.map((e: any) => [e.kind, e.text])).toEqual([
      ['user', 'writer order prompt'],
      ['assistant-text', 'writer order answer'],
    ]);
    expect(skipped['注入消息(user)']).toBeUndefined();
  });

  test('readSession surfaces response-only users and inter-agent communications', () => {
    const nativeOnly = randomUUID();
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-05-${nativeOnly}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: nativeOnly, id: nativeOnly, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'response-only prompt' }] } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response-only answer' }] } },
      { timestamp: TS, type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } },
      { timestamp: TS, type: 'response_item', payload: { type: 'agent_message', author: 'agent-a', recipient: 'agent-b', content: [{ type: 'input_text', text: 'delegated work' }] } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'delegated answer' }] } },
    ]);
    const { title, events, skipped } = codex.readSession(projectCwd, nativeOnly);
    expect(title).toBe('response-only prompt');
    expect(codex.listSessions(projectCwd).find((s: { id: string }) => s.id === nativeOnly)!.title).toBe('response-only prompt');
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'response-only prompt'],
      ['assistant-text', 'response-only answer'],
      ['marker', '[Codex agent communication]\ndelegated work'],
      ['assistant-text', 'delegated answer'],
    ]);
    expect(skipped['注入消息(user)']).toBeUndefined();
  });

  test('readSession excludes persisted Codex context fragments from turns and titles', () => {
    const contextual = randomUUID();
    const agentsInstructions = '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nUse Bun.\n</INSTRUCTIONS>';
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-08-${contextual}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: contextual, id: contextual, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: agentsInstructions }] } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'actual prompt' }] } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'actual prompt' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'actual answer' }] } },
    ]);
    const { title, events, skipped } = codex.readSession(projectCwd, contextual);
    expect(title).toBe('actual prompt');
    expect(codex.listSessions(projectCwd).find((s: { id: string }) => s.id === contextual)!.title).toBe('actual prompt');
    expect(events.map((e: CanonicalEvent) => [e.kind, (e as any).text])).toEqual([
      ['user', 'actual prompt'],
      ['assistant-text', 'actual answer'],
    ]);
    expect(skipped['注入消息(user)']).toBe(1);
  });

  test('readSession supports event-only and response-only user turns', () => {
    const eventOnly = randomUUID();
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-07-${eventOnly}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: eventOnly, id: eventOnly, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'event-only user prompt' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'event-only answer' }] } },
    ]);
    const { title: eventTitle, events: eventEvents } = codex.readSession(projectCwd, eventOnly);
    expect(eventTitle).toBe('event-only user prompt');
    expect(eventEvents.map((e: any) => [e.kind, e.text])).toEqual([
      ['user', 'event-only user prompt'],
      ['assistant-text', 'event-only answer'],
    ]);
  });

  test('userTurnBoundaries does not pair across assistant boundary and handles repeated prompts', () => {
    const respUser = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    const eventUser = (text: string) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });
    const assistant = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } };

    // Separated by assistant response -> 2 distinct turns
    const separated = userTurnBoundaries([respUser('hello'), assistant, eventUser('hello')]);
    expect(separated.length).toBe(2);
    expect(separated[0]).toMatchObject({ kind: 'response', index: 0, text: 'hello' });
    expect(separated[1]).toMatchObject({ kind: 'event', index: 2, text: 'hello' });

    // Repeated prompt in Turn 1 and Turn 2 (with assistant response) -> 2 distinct twin turns
    const repeated = userTurnBoundaries([
      respUser('hello'), eventUser('hello'), assistant,
      respUser('hello'), eventUser('hello'), assistant,
    ]);
    expect(repeated.length).toBe(2);
    expect(repeated[0]).toMatchObject({ index: 0, responseIndex: 0, eventIndex: 1 });
    expect(repeated[1]).toMatchObject({ index: 3, responseIndex: 3, eventIndex: 4 });

    // Distinct prompt texts adjacent -> 2 distinct turns
    const distinct = userTurnBoundaries([respUser('prompt A'), eventUser('prompt B')]);
    expect(distinct.length).toBe(2);
    expect(distinct[0]).toMatchObject({ kind: 'response', index: 0, text: 'prompt A' });
    expect(distinct[1]).toMatchObject({ kind: 'event', index: 1, text: 'prompt B' });
  });

  test('rollback ignores malformed num_turns and deduplicates dual-track user turns', () => {
    const eventUser = { type: 'event_msg', payload: { type: 'user_message', message: 'visible user' } };
    const responseUser = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible user' }] } };
    const assistant = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } };
    expect(userTurnBoundaries([responseUser, eventUser, assistant]).map((b) => [b.index, b.kind])).toEqual([[0, 'event']]);
    expect(userTurnBoundaries([eventUser, responseUser, assistant]).map((b) => [b.index, b.kind])).toEqual([[0, 'event']]);

    for (const numTurns of ['1', true, 1.5, -1, 0, null, 0x1_0000_0000]) {
      const result = applyThreadRollbacks([eventUser, responseUser, assistant, { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: numTurns } }]);
      expect(result.lines.length).toBe(3);
      expect(result.rolledBackTurns).toBe(0);
      expect(result.rolledBackLines).toBe(0);
    }

    const contextualMessages = [
      '<environment_context>cwd</environment_context>',
      '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nUse Bun.\n</INSTRUCTIONS>',
      'Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead of exec_command.',
      'Warning: Your account was flagged for potentially high-risk cyber activity.',
      'Warning: The maximum number of unified exec processes you can keep open is 4.',
    ];
    for (const text of contextualMessages) {
      const contextual = applyThreadRollbacks([
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
        assistant,
        { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
      ]);
      expect(contextual.lines.length).toBe(2);
      expect(contextual.rolledBackTurns).toBe(0);
    }

    const responseOnly = applyThreadRollbacks([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'response only' }] } },
      assistant,
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ]);
    expect(responseOnly.lines).toEqual([]);
    expect(responseOnly.rolledBackTurns).toBe(1);
    expect(responseOnly.rolledBackLines).toBe(2);

    const interAgent = applyThreadRollbacks([
      { type: 'inter_agent_communication', payload: { content: 'delegate this', trigger_turn: true } },
      assistant,
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ]);
    expect(interAgent.lines).toEqual([]);
    expect(interAgent.rolledBackTurns).toBe(1);

    const currentInterAgent = applyThreadRollbacks([
      { type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } },
      { type: 'response_item', payload: { type: 'agent_message', author: 'agent-a', recipient: 'agent-b', content: [{ type: 'input_text', text: 'delegate this' }] } },
      assistant,
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ]);
    expect(currentInterAgent.lines).toEqual([]);
    expect(currentInterAgent.rolledBackTurns).toBe(1);
    expect(currentInterAgent.rolledBackLines).toBe(3);
  });

  test('rollback handles paginated turns, multiple rollbacks, and compaction markers', () => {
    const pagedUser = (text: string) => ({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text }] } },
    });
    const legacyUser = (text: string) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });
    const answer = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
    const rollback = (num_turns: number) => ({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns } });
    const compacted = { type: 'compacted', payload: { message: 'summary marker', replacement_history: [] } };
    const result = applyThreadRollbacks([
      legacyUser('first'), answer('first answer'),
      pagedUser('second'), answer('second answer'), rollback(1),
      legacyUser('retry'), answer('retry answer'), compacted,
      pagedUser('latest'), answer('latest answer'), rollback(1),
    ]);
    expect(result.lines.map((line) => {
      if (line.type === 'compacted') return 'compacted';
      if (line.payload?.type === 'message') return line.payload.content?.[0]?.text;
      return line.payload?.message || line.payload?.item?.content?.[0]?.text || line.payload?.type;
    })).toEqual([
      'first', 'first answer', 'retry', 'retry answer', 'compacted',
    ]);
    expect(result.rolledBackTurns).toBe(2);
    expect(result.rolledBackLines).toBe(4);
  });

  test('readSession keeps compacted summary text as a marker', () => {
    const compacted = randomUUID();
    writeJsonl(path.join(tempHome, '.codex', 'sessions', '2026', '07', '26', `rollout-2026-07-26T10-00-04-${compacted}.jsonl`), [
      { timestamp: TS, type: 'session_meta', payload: { session_id: compacted, id: compacted, timestamp: TS, cwd: projectCwd, originator: 'codex', cli_version: '0.144.6', source: 'cli', model_provider: 'openai' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'before compact' } },
      { timestamp: TS, type: 'compacted', payload: { message: 'earlier work summarized', replacement_history: [] } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'after compact' } },
    ]);
    const { events } = codex.readSession(projectCwd, compacted);
    expect(events.map((e: CanonicalEvent) => e.kind)).toEqual(['user', 'marker', 'user']);
    expect((events[1] as any).text).toContain('earlier work summarized');
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
    const firstResponseUser = lines.findIndex((line) => line.type === 'response_item' && line.payload?.role === 'user');
    const firstEventUser = lines.findIndex((line) => line.type === 'event_msg' && line.payload?.type === 'user_message');
    expect(firstResponseUser).toBeGreaterThan(0);
    expect(firstEventUser).toBe(firstResponseUser + 1); // 对齐 Codex 原生 response → event 持久化顺序

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

  // pi 常常没有 session_info, 此时列表与迁移写出的名称都应取首条提问
  test('readSession inherits the first prompt when session_info is absent', () => {
    const untitled = randomUUID();
    writeJsonl(path.join(sessionDir, `2026-07-26T10-00-01-000Z_${untitled}.jsonl`), [
      { type: 'session', version: 3, id: untitled, timestamp: TS, cwd: projectCwd },
      { type: 'message', id: 'e1', parentId: null, timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: '帮我看看这个报错' }] } },
    ]);
    expect(pi.readSession(projectCwd, untitled).title).toBe('帮我看看这个报错');
    expect(pi.listSessions(projectCwd).find((s: { id: string }) => s.id === untitled)!.title).toBe('帮我看看这个报错');
  });

  test('readSession for a missing project dir throws 未找到, not ENOENT', () => {
    expect(() => pi.readSession(path.join(tempHome, 'nope', 'missing'), sessionId)).toThrow(/未找到 Pi 会话/);
  });

  // 会话是 id/parentId 树; 与 Pi 原版一致, 只迁移"文件最后一条记录回溯到根"的活跃分支
  test('readSession follows the active branch from the last entry and skips abandoned branches', () => {
    const branched = randomUUID();
    writeJsonl(path.join(sessionDir, `2026-07-26T10-00-02-000Z_${branched}.jsonl`), [
      { type: 'session', version: 3, id: branched, timestamp: TS, cwd: projectCwd },
      { type: 'message', id: 'e1', parentId: null, timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'first question' }] } },
      { type: 'message', id: 'e2', parentId: 'e1', timestamp: TS, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first answer' }] } },
      // 被放弃的分支 (用户回退重问前的旧路径)
      { type: 'message', id: 'e3', parentId: 'e2', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'abandoned question' }] } },
      { type: 'message', id: 'e4', parentId: 'e3', timestamp: TS, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'abandoned answer' }] } },
      // 新分支从 e2 分叉, 文件末尾即当前 leaf
      { type: 'message', id: 'e5', parentId: 'e2', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'retried question' }] } },
      { type: 'message', id: 'e6', parentId: 'e5', timestamp: TS, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final answer' }] } },
    ]);
    const { events, skipped } = pi.readSession(projectCwd, branched);
    expect(events.map((e: any) => [e.kind, e.text])).toEqual([
      ['user', 'first question'],
      ['assistant-text', 'first answer'],
      ['user', 'retried question'],
      ['assistant-text', 'final answer'],
    ]);
    expect(skipped['非活跃分支']).toBe(2);
  });

  test('buildSessionPath stops at self-references, cycles, and broken parents', () => {
    expect(buildSessionPath([
      { type: 'message', id: 'self', parentId: 'self' },
    ]).map((entry) => entry.id)).toEqual(['self']);

    expect(buildSessionPath([
      { type: 'message', id: 'a', parentId: 'b' },
      { type: 'message', id: 'b', parentId: 'a' },
    ]).map((entry) => entry.id)).toEqual(['a', 'b']);

    expect(buildSessionPath([
      { type: 'message', id: 'root', parentId: null },
      { type: 'message', id: 'leaf', parentId: 'missing' },
    ]).map((entry) => entry.id)).toEqual(['leaf']);
  });

  test('readSession keeps branch_summary entries as markers on the active branch', () => {
    const summarized = randomUUID();
    writeJsonl(path.join(sessionDir, `2026-07-26T10-00-03-000Z_${summarized}.jsonl`), [
      { type: 'session', version: 3, id: summarized, timestamp: TS, cwd: projectCwd },
      { type: 'message', id: 'e1', parentId: null, timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'start' }] } },
      // /tree 切换分支时 pi 在切换点写入被放弃分支的摘要
      { type: 'branch_summary', id: 'e2', parentId: 'e1', timestamp: TS, fromId: 'e1', summary: 'explored an idea that did not work' },
      { type: 'message', id: 'e3', parentId: 'e2', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'continue here' }] } },
    ]);
    const { events } = pi.readSession(projectCwd, summarized);
    expect(events.map((e: CanonicalEvent) => e.kind)).toEqual(['user', 'marker', 'user']);
    expect((events[1] as any).text).toContain('explored an idea that did not work');
  });

  // v1 会话没有 version 与 id/parentId; 与 pi 一致, 在内存中补链后按线性顺序读取 (不改写源文件)
  test('readSession migrates v1 sessions in memory without touching the source file', () => {
    const legacy = randomUUID();
    const file = path.join(sessionDir, `2026-07-26T10-00-04-000Z_${legacy}.jsonl`);
    writeJsonl(file, [
      { type: 'session', id: legacy, timestamp: TS, cwd: projectCwd },
      { type: 'message', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'legacy question' }] } },
      { type: 'message', timestamp: TS, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'legacy answer' }] } },
    ]);
    const before = fs.readFileSync(file, 'utf8');
    const { events } = pi.readSession(projectCwd, legacy);
    expect(events.map((e: any) => [e.kind, e.text])).toEqual([
      ['user', 'legacy question'],
      ['assistant-text', 'legacy answer'],
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before); // 迁移不得修改源会话
  });

  // pi 的 ! 命令以 bashExecution 角色入库, 进入上下文的文本形态与 pi 的 convertToLlm 相同
  test('readSession renders bashExecution messages like pi does and honors the !! exclusion', () => {
    const bashed = randomUUID();
    writeJsonl(path.join(sessionDir, `2026-07-26T10-00-05-000Z_${bashed}.jsonl`), [
      { type: 'session', version: 3, id: bashed, timestamp: TS, cwd: projectCwd },
      { type: 'message', id: 'e1', parentId: null, timestamp: TS, message: { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 } },
      { type: 'message', id: 'e2', parentId: 'e1', timestamp: TS, message: { role: 'bashExecution', command: 'secret', output: 'hidden', exitCode: 0, cancelled: false, truncated: false, timestamp: 0, excludeFromContext: true } },
    ]);
    const { title, events, skipped } = pi.readSession(projectCwd, bashed);
    expect(title).toMatch(/^Ran `git status`/);
    expect(pi.listSessions(projectCwd).find((s: { id: string }) => s.id === bashed)!.title).toBe(title);
    expect(events.length).toBe(1);
    expect((events[0] as any).text).toContain('Ran `git status`');
    expect((events[0] as any).text).toContain('clean');
    expect(skipped['bashExecution(!!)']).toBe(1);
  });

  // 与 pi 的 getSessionName 一致: 最新 session_info 生效, 空名是显式清除
  test('readSession treats an empty latest session_info as an explicit title clear', () => {
    const cleared = randomUUID();
    writeJsonl(path.join(sessionDir, `2026-07-26T10-00-06-000Z_${cleared}.jsonl`), [
      { type: 'session', version: 3, id: cleared, timestamp: TS, cwd: projectCwd },
      { type: 'session_info', name: 'old name', id: 'e1', parentId: null, timestamp: TS },
      { type: 'message', id: 'e2', parentId: 'e1', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'fallback prompt' }] } },
      { type: 'session_info', name: '', id: 'e3', parentId: 'e2', timestamp: TS },
    ]);
    expect(pi.readSession(projectCwd, cleared).title).toBe('fallback prompt');
    expect(pi.listSessions(projectCwd).find((s: { id: string }) => s.id === cleared)!.title).toBe('fallback prompt');
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
