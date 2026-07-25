// Cursor 会话读取：只读打开 globalStorage/state.vscdb
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export function cursorDbPath() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

export function openCursorDb(dbPath = cursorDbPath()) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`未找到 Cursor 数据库: ${dbPath}`);
  }
  // Cursor 正在运行时也持续写入(WAL), 必须只读打开
  return new DatabaseSync(dbPath, { readOnly: true });
}

function kvGet(db, key) {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
  if (!row || row.value == null) return null;
  const text = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 规范化路径用于比较: 小写盘符、统一斜杠
function normPath(p) {
  return String(p || '').replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
}

// 列出会话。projectPath 为 null 时列出所有项目的会话
export function listSessions(db, projectPath) {
  const rows = db
    .prepare('SELECT composerId, lastUpdatedAt, value FROM composerHeaders WHERE isSubagent = 0 ORDER BY lastUpdatedAt DESC')
    .all();
  const target = projectPath ? normPath(projectPath) : null;
  const sessions = [];
  for (const row of rows) {
    let head;
    try {
      head = JSON.parse(row.value);
    } catch {
      continue;
    }
    const fsPath = head?.workspaceIdentifier?.uri?.fsPath || '';
    if (target && normPath(fsPath) !== target) continue;
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
