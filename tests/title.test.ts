// 标题解析规则: 显式标题 → 首条可用用户消息 → 带 Harness 名称的兜底
import { describe, expect, test } from 'bun:test';
import { normalizeTitle, TITLE_MAX_LENGTH, titleFromEvents, titleFromMessage, untitledSession } from '../src/title.ts';
import type { CanonicalEvent } from '../src/types.ts';

const TS = '2026-07-26T10:00:00.000Z';

describe('normalizeTitle', () => {
  test('折叠空白并去掉首尾空格', () => {
    expect(normalizeTitle('  多行\n标题   文本 ')).toBe('多行 标题 文本');
  });

  test('截断到标题长度上限', () => {
    expect(normalizeTitle('x'.repeat(200))).toHaveLength(TITLE_MAX_LENGTH);
  });

  test('空值归一为空串', () => {
    expect(normalizeTitle(undefined)).toBe('');
    expect(normalizeTitle(null)).toBe('');
  });
});

describe('titleFromMessage', () => {
  test('保留正常的首条提问', () => {
    expect(titleFromMessage('鸣人是谁')).toBe('鸣人是谁');
  });

  test('拒绝迁移来源标记, 避免链式迁移继承它', () => {
    expect(titleFromMessage('[agent-connect] 本会话由 Claude Code 会话《X》迁移而来。')).toBe('');
  });

  test('拒绝 Harness 注入的包装消息', () => {
    expect(titleFromMessage('<command-name>/model</command-name>')).toBe('');
    expect(titleFromMessage('<local-command-caveat> ...')).toBe('');
  });

  test('只是以尖括号开头的正常提问仍然保留', () => {
    expect(titleFromMessage('<3 这个符号怎么打')).toBe('<3 这个符号怎么打');
  });
});

describe('titleFromEvents', () => {
  test('跳过标记与包装消息, 取第一条真正的提问', () => {
    const events: CanonicalEvent[] = [
      { kind: 'marker', ts: TS, text: '[agent-connect] 来源说明' },
      { kind: 'user', ts: TS, text: '[agent-connect] 迁移而来' },
      { kind: 'assistant-text', ts: TS, text: '助手回复' },
      { kind: 'user', ts: TS, text: '真正的问题' },
    ];
    expect(titleFromEvents(events)).toBe('真正的问题');
  });

  test('没有可用用户消息时返回空串', () => {
    expect(titleFromEvents([{ kind: 'assistant-text', ts: TS, text: '只有助手输出' }])).toBe('');
  });
});

test('untitledSession 给出 Harness 名称而不是裸会话 id', () => {
  expect(untitledSession('Claude Code', '019f9d47-1234-5678')).toBe('Claude Code 会话 019f9d47');
});
