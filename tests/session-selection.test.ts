import { describe, expect, test } from 'bun:test';
import { selectSession } from '../src/commands/to.ts';
import type { ListedSession } from '../src/types.ts';

const sessions: ListedSession[] = [
  { id: 'abcde-111', title: 'Fix login flow', updatedAt: 3, source: 'pi', sourceLabel: 'Pi' },
  { id: 'abcde-222', title: 'Fix login flow', updatedAt: 2, source: 'codex', sourceLabel: 'Codex CLI' },
  { id: 'fffff-333', title: 'Release notes', updatedAt: 1, source: 'claude', sourceLabel: 'Claude Code' },
];

describe('direct migration selection', () => {
  test('prefers an exact ID over a broader matching prefix', () => {
    expect(selectSession(sessions, 'cursor', 'abcde-111').id).toBe('abcde-111');
  });
  test('rejects ambiguous ID prefixes and title searches', () => {
    expect(() => selectSession(sessions, 'cursor', 'abcde')).toThrow('匹配多个会话');
    expect(() => selectSession(sessions, 'cursor', 'Fix login')).toThrow('匹配多个会话');
  });
  test('selects the newest session from a different target when no reference is supplied', () => {
    expect(selectSession(sessions, 'pi').id).toBe('abcde-222');
  });
});
