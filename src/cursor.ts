// @ts-nocheck
// Cursor 会话读取：只读打开 globalStorage/state.vscdb
import { Database } from 'bun:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function cursorUserDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User');
}

export function cursorDbPath() {
  return path.join(cursorUserDir(), 'globalStorage', 'state.vscdb');
}

export function cursorWorkspaceStoragePath() {
  return path.join(cursorUserDir(), 'workspaceStorage');
}

export function openCursorDb(dbPath = cursorDbPath()) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`未找到 Cursor 数据库: ${dbPath}`);
  }
  // Cursor 正在运行时也持续写入(WAL), 必须只读打开
  return new Database(dbPath, { readonly: true });
}

function kvGet(db, key) {
  const row = db.query('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
  if (!row || row.value == null) return null;
  const text = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Normalize only Windows paths case-insensitively; Linux and macOS paths may be case-sensitive.
export function normalizeCursorPath(p) {
  const normalized = String(p || '').replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// 列出会话。projectPath 为 null 时列出所有项目的会话
export function listSessions(db, projectPath) {
  const rows = db
    .query('SELECT composerId, lastUpdatedAt, value FROM composerHeaders WHERE isSubagent = 0 ORDER BY lastUpdatedAt DESC')
    .all();
  const target = projectPath ? normalizeCursorPath(projectPath) : null;
  const sessions = [];
  for (const row of rows) {
    let head;
    try {
      head = JSON.parse(row.value);
    } catch {
      continue;
    }
    const fsPath = head?.workspaceIdentifier?.uri?.fsPath || '';
    if (target && normalizeCursorPath(fsPath) !== target) continue;
    sessions.push({
      composerId: row.composerId,
      name: head.name || '(无标题)',
      subtitle: head.subtitle || '',
      createdAt: head.createdAt,
      lastUpdatedAt: head.lastUpdatedAt || row.lastUpdatedAt,
      mode: head.unifiedMode || '',
      projectPath: fsPath,
    });
  }
  return sessions;
}

// 加载完整会话: composerData + 按时间线取全部 bubble
export function loadSession(db, composerId) {
  const composer = kvGet(db, `composerData:${composerId}`);
  if (!composer) {
    throw new Error(`未找到 Cursor 会话: ${composerId}`);
  }
  const headers = composer.fullConversationHeadersOnly || [];
  const bubbles = [];
  for (const h of headers) {
    const bubble = kvGet(db, `bubbleId:${composerId}:${h.bubbleId}`);
    bubbles.push({ header: h, bubble });
  }
  return { composerId, composer, bubbles };
}

// 内容寻址的文件全文快照 (edit_file_v2 的 afterContentId 指向)
export function loadContentSnapshot(db, contentId) {
  return kvGet(db, contentId);
}

// 子代理会话: task_v2 result.agentId 即子 composerId
export function loadSubagentSession(db, agentComposerId) {
  try {
    return loadSession(db, agentComposerId);
  } catch {
    return null;
  }
}
