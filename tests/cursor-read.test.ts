// src/cursor.ts 只读逻辑: 用一次性 state.vscdb 验证, 不触碰真实 Cursor 数据库
// cursor-writer.ts 的 writeCursorSession 不在此测试 (assertCursorClosed 检查真实进程)
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, loadContentSnapshot, loadSession, openCursorDb } from '../src/cursor.ts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-cursor-'));
const dbPath = path.join(tempDir, 'state.vscdb');

const PROJECT_A = 'c:/work/proj-a';
const PROJECT_B = 'c:/work/proj-b';

// 与 src/cursor.ts 查询的列集合一致 (composerId/lastUpdatedAt/value + isSubagent 过滤)
{
  const seed = new Database(dbPath, { create: true });
  seed.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT)');
  seed.exec('CREATE TABLE composerHeaders(composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT)');

  const header = (name: string, fsPath: string, createdAt: number, lastUpdatedAt: number): string =>
    JSON.stringify({ name, subtitle: '', createdAt, lastUpdatedAt, unifiedMode: 2, workspaceIdentifier: { uri: { fsPath } } });
  const insertHeader = seed.query('INSERT INTO composerHeaders(composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertHeader.run('c1', 'w1', 1000, 2000, 0, 0, 2000, 0, header('first session', PROJECT_A, 1000, 2000));
  insertHeader.run('c2', 'w2', 1100, 1900, 0, 0, 1900, 0, header('other project session', PROJECT_B, 1100, 1900));
  insertHeader.run('c3', 'w1', 1200, 1800, 0, 1, 1800, 0, header('subagent session', PROJECT_A, 1200, 1800)); // isSubagent=1 应被过滤
  insertHeader.run('c4', 'w1', 1300, 1700, 0, 0, 1700, 0, 'not-json {{{'); // 损坏行应被跳过

  const insertKv = seed.query('INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)');
  insertKv.run('composerData:c1', JSON.stringify({
    composerId: 'c1', name: 'first session', createdAt: 1000,
    fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }],
  }));
  insertKv.run('bubbleId:c1:b1', JSON.stringify({ type: 1, text: 'hello cursor', createdAt: '2026-07-26T10:00:00.000Z' }));
  insertKv.run('bubbleId:c1:b2', JSON.stringify({ type: 2, text: 'hi from cursor' }));
  insertKv.run('composerData:broken', 'not-json {{{'); // 无效 JSON 行
  seed.close();
}

const db = openCursorDb(dbPath);

afterAll(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('cursor listSessions', () => {
  test('filters by workspaceIdentifier.uri.fsPath and skips subagent/corrupt rows', () => {
    const sessions = listSessions(db, PROJECT_A);
    expect(sessions.map((s: { composerId: string }) => s.composerId)).toEqual(['c1']);
    expect(sessions[0]!.name).toBe('first session');
    expect(sessions[0]!.projectPath).toBe(PROJECT_A);
    expect(sessions[0]!.lastUpdatedAt).toBe(2000);
  });

  test('normalizes backslashes and trailing slashes in the project path', () => {
    const sessions = listSessions(db, 'c:\\work\\proj-a\\');
    expect(sessions.map((s: { composerId: string }) => s.composerId)).toEqual(['c1']);
  });

  test('lists all projects when projectPath is null', () => {
    const ids = listSessions(db, null).map((s: { composerId: string }) => s.composerId);
    expect(ids.sort()).toEqual(['c1', 'c2']); // c3 是子代理, c4 损坏
  });
});

describe('cursor loadSession', () => {
  test('returns bubbles in fullConversationHeadersOnly order', () => {
    const session = loadSession(db, 'c1');
    expect(session.composerId).toBe('c1');
    expect(session.composer.name).toBe('first session');
    expect(session.bubbles.map((b: any) => b.header.bubbleId)).toEqual(['b1', 'b2']);
    expect(session.bubbles[0]!.bubble!.text).toBe('hello cursor');
    expect(session.bubbles[1]!.bubble!.text).toBe('hi from cursor');
  });

  test('throws 未找到 for an unknown composerId', () => {
    expect(() => loadSession(db, 'missing-id')).toThrow(/未找到 Cursor 会话/);
  });

  test('a corrupt composerData row reads as missing instead of throwing a parse error', () => {
    expect(() => loadSession(db, 'broken')).toThrow(/未找到 Cursor 会话/);
  });
});

describe('cursor kvGet behavior', () => {
  test('invalid-JSON rows are skipped (null) without throwing', () => {
    expect(loadContentSnapshot(db, 'composerData:broken')).toBeNull();
  });

  test('missing keys return null', () => {
    expect(loadContentSnapshot(db, 'no-such-key')).toBeNull();
  });
});

describe('openCursorDb', () => {
  test('throws 未找到 when the database file does not exist', () => {
    expect(() => openCursorDb(path.join(tempDir, 'nope.vscdb'))).toThrow(/未找到 Cursor 数据库/);
  });
});
