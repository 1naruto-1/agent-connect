import { describe, expect, test } from 'bun:test';
import { analyzeEvents, canonicalToolFromName, normalizeCommand, renderReport, safeParse } from '../src/events.ts';
import type { CanonicalEvent } from '../src/types.ts';

describe('safeParse', () => {
  test('passes plain objects through unchanged', () => {
    const value = { type: 'user', nested: { a: 1 } };
    expect(safeParse(value)).toBe(value);
  });

  test('parses JSON object strings', () => {
    expect(safeParse('{"type":"user","n":1}')).toEqual({ type: 'user', n: 1 });
  });

  test('returns null for invalid JSON', () => {
    expect(safeParse('{oops')).toBeNull();
    expect(safeParse('')).toBeNull();
    expect(safeParse('not json at all')).toBeNull();
  });

  test('returns null for arrays, raw or serialized', () => {
    expect(safeParse([1, 2, 3])).toBeNull();
    expect(safeParse('[1,2,3]')).toBeNull();
  });

  test('returns null for null, undefined, and non-string scalars', () => {
    expect(safeParse(null)).toBeNull();
    expect(safeParse(undefined)).toBeNull();
    expect(safeParse(42)).toBeNull();
    expect(safeParse('42')).toBeNull();
  });
});

describe('normalizeCommand', () => {
  test('passes strings through unchanged', () => {
    expect(normalizeCommand('ls -la')).toBe('ls -la');
  });

  test('unwraps ["bash","-lc",...] wrappers', () => {
    expect(normalizeCommand(['bash', '-lc', 'ls'])).toBe('ls');
  });

  test('unwraps ["sh","-c",...] wrappers', () => {
    expect(normalizeCommand(['sh', '-c', 'x'])).toBe('x');
  });

  test('joins generic arrays with spaces', () => {
    expect(normalizeCommand(['git', 'status', '--short'])).toBe('git status --short');
  });

  test('returns empty string for null and undefined', () => {
    expect(normalizeCommand(null)).toBe('');
    expect(normalizeCommand(undefined)).toBe('');
  });
});

describe('canonicalToolFromName', () => {
  test('shell with an array command yields a terminal event with a string command', () => {
    const call = canonicalToolFromName('shell', { command: ['bash', '-lc', 'ls -la'], description: 'list' });
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('terminal');
    expect(call!.input.command).toBe('ls -la');
    expect(typeof call!.input.command).toBe('string');
  });

  test('unknown tool name returns null', () => {
    expect(canonicalToolFromName('quantum_flux_capacitor', { any: 1 })).toBeNull();
    expect(canonicalToolFromName(undefined)).toBeNull();
  });

  test('shell without a command returns null', () => {
    expect(canonicalToolFromName('shell', {})).toBeNull();
    expect(canonicalToolFromName('bash', { command: '' })).toBeNull();
  });

  test('read aliases file_path to path', () => {
    expect(canonicalToolFromName('read_file', { file_path: '/tmp/a.txt' })).toEqual({ tool: 'read', input: { path: '/tmp/a.txt' } });
    expect(canonicalToolFromName('read', { path: '/tmp/b.txt' })!.input.path).toBe('/tmp/b.txt');
  });

  test('edit aliases old_string/new_string to oldText/newText', () => {
    const call = canonicalToolFromName('edit', { file_path: '/tmp/a.txt', old_string: 'before', new_string: 'after' });
    expect(call).toEqual({ tool: 'edit', input: { path: '/tmp/a.txt', oldText: 'before', newText: 'after' } });
  });

  test('write aliases file_path and keeps content', () => {
    const call = canonicalToolFromName('write', { file_path: '/tmp/a.txt', content: 'hello' });
    expect(call).toEqual({ tool: 'write', input: { path: '/tmp/a.txt', content: 'hello' } });
  });
});

describe('analyzeEvents', () => {
  const ts = '2026-07-26T10:00:00.000Z';
  const events: CanonicalEvent[] = [
    { kind: 'user', ts, text: 'hi' },
    { kind: 'user', ts, text: 'again' },
    { kind: 'assistant-text', ts, text: 'hello' },
    { kind: 'thinking', ts, text: 'hmm', signature: '' },
    { kind: 'marker', ts, text: '[note]' },
    { kind: 'tool', ts, tool: 'terminal', input: { command: 'ls' }, output: '', isError: false },
    { kind: 'tool', ts, tool: 'terminal', input: { command: 'pwd' }, output: '', isError: false },
    { kind: 'tool', ts, tool: 'mcp', input: { server: 'srv', toolName: 'do_it', args: {} }, output: '', isError: false },
    { kind: 'tool', ts, tool: 'other', input: { name: 'CustomTool', args: {} }, output: '', isError: false },
    { kind: 'tool', ts, tool: 'subagent', input: { prompt: 'go' }, output: '', isError: false },
  ];

  test('counts user/assistant/thinking/marker and buckets tools', () => {
    const stats = analyzeEvents(events);
    expect(stats.total).toBe(events.length);
    expect(stats.user).toBe(2);
    expect(stats.assistantText).toBe(1);
    expect(stats.thinking).toBe(1);
    expect(stats.markers).toBe(1);
    expect(stats.tools).toEqual({ terminal: 2 });
    expect(stats.subagents).toBe(1);
  });

  test('mcp bucket key is server/toolName and other bucket keys on name', () => {
    const stats = analyzeEvents(events);
    expect(stats.mcp).toEqual({ 'srv/do_it': 1 });
    expect(stats.other).toEqual({ CustomTool: 1 });
  });

  test('passes skipped counts through', () => {
    const skipped = { 'file-history-snapshot': 3 };
    const stats = analyzeEvents([], skipped);
    expect(stats.skipped).toEqual({ 'file-history-snapshot': 3 });
    expect(analyzeEvents([]).skipped).toEqual({});
  });
});

describe('renderReport', () => {
  const base = { source: 'Pi', target: 'Claude Code', title: 'fixture', notes: ['note-a'] };

  test('includes the skipped stats line when skipped entries exist', () => {
    const stats = analyzeEvents([], { 'file-history-snapshot': 3, queue: 1 });
    const report = renderReport({ ...base, stats });
    expect(report).toContain('未迁移的源记录');
    expect(report).toContain('file-history-snapshot×3');
    expect(report).toContain('queue×1');
    expect(report).toContain('note-a');
  });

  test('omits the skipped stats line when nothing was skipped', () => {
    const report = renderReport({ ...base, stats: analyzeEvents([]) });
    expect(report).not.toContain('未迁移的源记录');
  });
});
