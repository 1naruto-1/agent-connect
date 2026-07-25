// Cursor 数据库写入: 仅 INSERT 全新 composerId 的行, 绝不改动已有数据
// composerData 严格复刻 legacy (_v16 无 agentBackend) 格式的完整字段集
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { cursorDbPath } from './cursor.js';

export function assertCursorClosed() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Cursor.exe" /NH', { encoding: 'utf8' });
    if (out.includes('Cursor.exe')) {
      throw new Error('Cursor 正在运行。写入其数据库前请先完全退出 Cursor (托盘图标也要退出), 然后重试。');
    }
  } catch (e) {
    if (e.message.includes('Cursor 正在运行')) throw e;
    // tasklist 不可用时跳过检测
  }
}

// 在 workspaceStorage 中找项目对应的 workspaceId
export function findWorkspaceId(cwd) {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const wsRoot = path.join(appData, 'Cursor', 'User', 'workspaceStorage');
  const target = cwd.replaceAll('\\', '/').toLowerCase();
  for (const dir of fs.readdirSync(wsRoot)) {
    const wsFile = path.join(wsRoot, dir, 'workspace.json');
    if (!fs.existsSync(wsFile)) continue;
    try {
      const folder = JSON.parse(fs.readFileSync(wsFile, 'utf8')).folder || '';
      const folderPath = decodeURIComponent(folder.replace('file:///', '')).replace(/^([a-z])%3a/i, '$1:').toLowerCase();
      if (folderPath === target || folderPath === target.replace(':', '%3a')) return dir;
    } catch {}
  }
  throw new Error(`Cursor 从未打开过项目 ${cwd} (workspaceStorage 中无对应 workspace), 请先在 Cursor 中打开一次该项目。`);
}

// 写入一个完整会话, 返回 composerId
export function writeCursorSession(cwd, name, bubbles) {
  assertCursorClosed();
  const workspaceId = findWorkspaceId(cwd);
  const composerId = randomUUID();
  const now = Date.now();
  const createdAt = bubbles[0] ? Date.parse(bubbles[0].header.createdAt) : now;
  const lastUpdatedAt = bubbles.at(-1) ? Date.parse(bubbles.at(-1).header.createdAt) : now;
  const fsPath = cwd.replace(/^([A-Z]):/, (m, d) => d.toLowerCase() + ':');
  const external = 'file:///' + encodeURIComponent(fsPath.replaceAll('\\', '/')).replaceAll('%2F', '/').replace(/^([a-z])%3A/i, (m, d) => d + '%3A');
  const workspaceIdentifier = {
    id: workspaceId,
    uri: { $mid: 1, fsPath, _sep: 1, external, path: '/' + fsPath.replaceAll('\\', '/'), scheme: 'file' },
  };

  // legacy 格式 composerData: 无 agentBackend, Cursor 直接从 JSON bubble 渲染
  const composerData = {
    _v: 16,
    composerId,
    richText: '',
    hasLoaded: true,
    text: '',
    fullConversationHeadersOnly: bubbles.map((b) => b.header),
    conversationMap: {},
    status: 'completed',
    context: {
      composers: [], selectedCommits: [], selectedPullRequests: [], selectedImages: [], selectedDocuments: [],
      selectedVideos: [], folderSelections: [], fileSelections: [], selections: [], terminalSelections: [],
      useContextPicking: [], useDiffReview: [], externalLinks: [], notepads: [], quotes: [], mentions: {},
    },
    generatingBubbleIds: [],
    isReadingLongFile: false,
    codeBlockData: {},
    originalFileStates: {},
    newlyCreatedFiles: [],
    newlyCreatedFolders: [],
    conversationCheckpointLastUpdatedAt: lastUpdatedAt,
    createdAt,
    lastUpdatedAt,
    hasChangedContext: false,
    activeTabsShouldBeReactive: true,
    capabilities: [
      { type: 15, data: { bubbleDataMap: '{}' } },
      { type: 19, data: {} }, { type: 33, data: {} }, { type: 32, data: {} },
      { type: 23, data: {} }, { type: 16, data: {} }, { type: 24, data: {} },
    ],
    name,
    isFileListExpanded: false,
    canvasPillCollapsed: false,
    browserChipManuallyDisabled: false,
    browserChipManuallyEnabled: false,
    unifiedMode: 'agent',
    forceMode: 'edit',
    usageData: {},
    allAttachedFileCodeChunksUris: [],
    modelConfig: { modelName: 'claude-code-import', maxMode: false, selectedModels: [] },
    subComposerIds: [],
    subagentComposerIds: [],
    capabilityContexts: [],
    todos: [],
    isQueueExpanded: true,
    hasUnreadMessages: false,
    gitHubPromptDismissed: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    addedFiles: 0,
    removedFiles: 0,
    isDraft: false,
    isCreatingWorktree: false,
    isApplyingWorktree: false,
    isUndoingWorktree: false,
    applied: false,
    pendingCreateWorktree: false,
    worktreeStartedReadOnly: false,
    isBestOfNSubcomposer: false,
    isBestOfNParent: false,
    isSpec: false,
    isProject: false,
    isSpecSubagentDone: false,
    isContinuationInProgress: false,
    stopHookLoopCount: 0,
    trackedGitRepos: [],
    speculativeSummarizationEncryptionKey: randomBytes(32).toString('base64'),
    isNAL: true,
    planModeSuggestionUsed: false,
    debugModeSuggestionUsed: false,
    conversationState: '~',
    queueItems: [],
    blobEncryptionKey: randomBytes(32).toString('base64'),
    latestChatGenerationUUID: randomUUID(),
    isAgentic: false,
    subtitle: '',
    filesChangedCount: 0,
    workspaceIdentifier,
  };

  const headerValue = {
    type: 'head',
    composerId,
    name,
    conversationCheckpointLastUpdatedAt: lastUpdatedAt,
    lastUpdatedAt,
    createdAt,
    unifiedMode: 'agent',
    forceMode: 'edit',
    hasUnreadMessages: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    filesChangedCount: 0,
    subtitle: '',
    hasBlockingPendingActions: false,
    hasPendingPlan: false,
    isArchived: false,
    isDraft: false,
    isWorktree: false,
    worktreeStartedReadOnly: false,
    isSpec: false,
    isProject: false,
    workspaceIdentifier,
  };

  const db = new DatabaseSync(cursorDbPath());
  try {
    db.exec('BEGIN');
    const kv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const b of bubbles) {
      kv.run(`bubbleId:${composerId}:${b.bubbleId}`, JSON.stringify(b.data));
    }
    kv.run(`composerData:${composerId}`, JSON.stringify(composerData));
    db.prepare('INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value) VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?)')
      .run(composerId, workspaceId, createdAt, lastUpdatedAt, lastUpdatedAt, JSON.stringify(headerValue));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.close();
  }
  return composerId;
}

// 删除本工具此前写入的会话 (仅删除指定 composerId 的行, 用于清理失败的实验)
export function deleteCursorSession(composerId) {
  assertCursorClosed();
  const db = new DatabaseSync(cursorDbPath());
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM cursorDiskKV WHERE key LIKE ?').run(`bubbleId:${composerId}:%`);
    db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`composerData:${composerId}`);
    db.prepare('DELETE FROM composerHeaders WHERE composerId = ?').run(composerId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.close();
  }
}
