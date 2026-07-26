// Cursor 数据库写入: 仅 INSERT 全新 composerId 的行, 绝不改动已有数据
// composerData 严格复刻 legacy (_v16 无 agentBackend) 格式的完整字段集
import { Database } from 'bun:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { cursorDbPath, cursorWorkspaceStoragePath, normalizeCursorPath } from './cursor.ts';
import type { NativeRecord } from './types.ts';

export interface CursorBubble {
  bubbleId: string;
  header: NativeRecord;
  data: NativeRecord;
}

function processOutput(command: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync({ cmd: command, stdout: 'pipe', stderr: 'pipe' });
  const decoder = new TextDecoder();
  return { exitCode: result.exitCode, output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}

// Writing while Cursor owns its database can corrupt a session store. Fail closed when unsure.
export function assertCursorClosed(): void {
  if (process.platform === 'win32') {
    const result = processOutput(['tasklist', '/FI', 'IMAGENAME eq Cursor.exe', '/NH']);
    if (result.exitCode !== 0) throw new Error('无法确认 Cursor 是否运行，已拒绝写入其数据库。请关闭 Cursor 后重试。');
    if (result.output.includes('Cursor.exe')) throw new Error('Cursor 正在运行。写入其数据库前请先完全退出 Cursor（包括托盘图标），然后重试。');
    return;
  }
  for (const processName of ['Cursor', 'cursor']) {
    const result = processOutput(['pgrep', '-x', processName]);
    if (result.exitCode === 0) throw new Error('Cursor 正在运行。写入其数据库前请先完全退出 Cursor，然后重试。');
    if (result.exitCode !== 1) throw new Error('无法确认 Cursor 是否运行，已拒绝写入其数据库。请关闭 Cursor 后重试。');
  }
}

// 在 workspaceStorage 中找项目对应的 workspaceId
export function findWorkspaceId(cwd: string): string {
  const wsRoot = cursorWorkspaceStoragePath();
  if (!fs.existsSync(wsRoot)) {
    throw new Error(`Cursor 从未打开过项目 ${cwd}（workspaceStorage 不存在），请先在 Cursor 中打开一次该项目。`);
  }
  const target = normalizeCursorPath(cwd);
  for (const dir of fs.readdirSync(wsRoot)) {
    const wsFile = path.join(wsRoot, dir, 'workspace.json');
    if (!fs.existsSync(wsFile)) continue;
    try {
      const folder = JSON.parse(fs.readFileSync(wsFile, 'utf8')).folder || '';
      const folderPath = normalizeCursorPath(folder.startsWith('file:') ? fileURLToPath(folder) : folder);
      if (folderPath === target) return dir;
    } catch {}
  }
  throw new Error(`Cursor 从未打开过项目 ${cwd} (workspaceStorage 中无对应 workspace), 请先在 Cursor 中打开一次该项目。`);
}

// 写入一个完整会话, 返回 composerId
export function writeCursorSession(cwd: string, name: string, bubbles: CursorBubble[]): string {
  assertCursorClosed();
  const workspaceId = findWorkspaceId(cwd);
  const composerId = randomUUID();
  const now = Date.now();
  // header.createdAt 可能是 ISO 字符串或毫秒数; 解析失败时退回当前时间, 不写入 NaN
  const toMs = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? now : parsed;
  };
  const firstBubble = bubbles[0];
  const lastBubble = bubbles.at(-1);
  const createdAt = firstBubble ? toMs(firstBubble.header.createdAt) : now;
  const lastUpdatedAt = lastBubble ? toMs(lastBubble.header.createdAt) : now;
  const fsPath = process.platform === 'win32' ? cwd.replace(/^([A-Z]):/, (m, d) => d.toLowerCase() + ':') : cwd;
  const external = pathToFileURL(fsPath).toString();
  const workspaceIdentifier = {
    id: workspaceId,
    // VS Code/Cursor 存储的是解码后的 URI path (含空格与非 ASCII 字符时不带百分号编码)
    uri: { $mid: 1, fsPath, _sep: 1, external, path: decodeURIComponent(new URL(external).pathname), scheme: 'file' },
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

  const db = new Database(cursorDbPath());
  try {
    // Cursor 可能在 assertCursorClosed 之后被重新启动; 立即取写锁并允许短暂等待, 失败即原子退出
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    const kv = db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const b of bubbles) {
      kv.run(`bubbleId:${composerId}:${b.bubbleId}`, JSON.stringify(b.data));
    }
    kv.run(`composerData:${composerId}`, JSON.stringify(composerData));
    db.query('INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value) VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?)')
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
