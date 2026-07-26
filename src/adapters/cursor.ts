// Cursor 适配器: globalStorage/state.vscdb (SQLite)
// 读取任意时可进行 (只读); 写入要求 Cursor 完全退出, 且只 INSERT 全新会话的行
import { randomUUID } from 'node:crypto';
import { openCursorDb, cursorDbPath, listSessions as listCursorSessions, loadSession, loadContentSnapshot, loadSubagentSession } from '../cursor.ts';
import { writeCursorSession, assertCursorClosed } from '../cursor-writer.ts';
import { safeParse } from '../events.ts';
import { normalizeTitle, titleFromEvents, untitledSession } from '../title.ts';
import fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { CursorBubble } from '../cursor-writer.ts';
import type { CanonicalEvent, NativeRecord, ReadSessionResult, SessionInfo, ToolEvent, WriteSessionResult } from '../types.ts';

export const id = 'cursor';
export const label = 'Cursor';

export function available(): boolean {
  return fs.existsSync(cursorDbPath());
}

let _db: Database | undefined;
function db(): Database {
  return (_db ??= openCursorDb());
}

export function listSessions(cwd: string): SessionInfo[] {
  try {
    return listCursorSessions(db(), cwd).map((s) => ({
      id: s.composerId,
      // src/cursor.ts 在没有 name 时填入 '(无标题)' 哨兵, 此时退回 Cursor 自己的 subtitle
      title: s.name === '(无标题)' && s.subtitle ? normalizeTitle(s.subtitle) : normalizeTitle(s.name),
      updatedAt: s.lastUpdatedAt || s.createdAt || 0,
      count: undefined,
    }));
  } catch (e) {
    // 数据库被锁/损坏或 schema 变化时不静默返回空列表, 至少把原因写到 stderr
    console.error(`[agent-connect] 读取 Cursor 会话列表失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ---- 读取: bubble 流 → 统一事件流 ----

function toolEvent(tf: NativeRecord, ts: string, dbh: Database): CanonicalEvent {
  const args = safeParse(tf.rawArgs) || safeParse(tf.params) || {};
  const params = safeParse(tf.params) || {};
  const result = safeParse(tf.result);
  const incomplete = tf.status !== 'completed';
  const ev = (tool: ToolEvent['tool'], input: ToolEvent['input'], output: string, isError = false): ToolEvent => ({
    kind: 'tool', ts, tool, input,
    output: incomplete ? `[该调用在 Cursor 中未完成 (status=${tf.status})]${output ? '\n' + output : ''}` : output,
    isError: incomplete || isError, origName: tf.name,
  });

  if (tf.name?.startsWith('mcp-')) {
    const server = args.providerIdentifier || tf.name.replace(/^mcp-/, '').split('-')[0];
    const toolName = args.toolName || tf.name;
    const inner = safeParse(result?.result);
    const text = inner?.content?.map((c: NativeRecord) => c.text || '').join('\n') ?? (result ? JSON.stringify(result) : '');
    return ev('mcp', { server, toolName, args: args.args || args }, text);
  }
  switch (tf.name) {
    case 'run_terminal_command_v2': {
      const output = result?.output ?? '';
      if (result?.rejected) return ev('terminal', { command: args.command || '' }, '[用户在 Cursor 中拒绝执行该命令]', true);
      return ev('terminal', { command: args.command || params.command || '', description: params.commandDescription },
        result?.exitCode ? `${output}\nExit code: ${result.exitCode}` : output, !!result?.exitCode);
    }
    case 'read_file_v2':
      return ev('read', { path: args.path || params.targetFile || '' }, result?.contents ?? '');
    case 'edit_file_v2': {
      const filePath = params.relativeWorkspacePath || '';
      const diffLines: NativeRecord[] | undefined = tf.additionalData?.precomputedDiff?.lines;
      if (Array.isArray(diffLines) && diffLines.length > 0) {
        if (diffLines.every((l) => l.type === 'added')) {
          return ev('write', { path: filePath, content: diffLines.map((l) => l.content).join('\n') }, `File created: ${filePath}`);
        }
        // 多 hunk 合并为一次 edit (removed→old, added→new); 事件级无损足够恢复语境
        const oldText = diffLines.filter((l) => l.type === 'removed').map((l) => l.content).join('\n');
        const newText = diffLines.filter((l) => l.type === 'added').map((l) => l.content).join('\n');
        return ev('edit', { path: filePath, oldText, newText }, `The file ${filePath} has been updated.`);
      }
      const snapshot = result?.afterContentId ? loadContentSnapshot(dbh, result.afterContentId) : null;
      const content = typeof snapshot === 'string' ? snapshot : snapshot?.content ?? snapshot?.contents;
      if (content != null) return ev('write', { path: filePath, content }, `File written: ${filePath}`);
      return ev('edit', { path: filePath, oldText: '', newText: '' }, '[Cursor 未记录此次编辑的 diff 与快照]', true);
    }
    case 'delete_file': {
      const deleted = String(args.path || args.targetFile || params.targetFile || '');
      // POSIX 单引号转义, 防止含引号的文件名产生残缺/可注入的命令文本
      return ev('terminal', { command: `rm '${deleted.replaceAll("'", `'\\''`)}'`, description: '删除文件' }, '');
    }
    case 'ripgrep_raw_search':
      return ev('grep', { pattern: args.pattern || args.query || args.searchTerm || '', path: args.path || args.targetDirectory }, result ? JSON.stringify(result, null, 1) : '');
    case 'glob_file_search':
      return ev('glob', { pattern: args.globPattern || args.pattern || '', path: args.targetDirectory }, result ? JSON.stringify(result, null, 1) : '');
    case 'web_search':
      return ev('web-search', { query: args.searchTerm || args.query || '' }, result ? JSON.stringify(result.references ?? result, null, 1) : '');
    case 'web_fetch':
      return ev('web-fetch', { url: args.url || '' }, result?.markdown ?? (result ? JSON.stringify(result) : ''));
    case 'todo_write':
      return ev('todo', { todos: (result?.finalTodos || []).map((t: NativeRecord) => ({ content: t.content, status: t.status })) }, 'Todos updated.');
    case 'ask_question': {
      const questions = (params.questions || []).map((q: NativeRecord) => ({ question: q.prompt || '', options: (q.options || []).map((o: NativeRecord) => o.label) }));
      const answers = (result?.answers || []).map((a: NativeRecord) => {
        const q = (params.questions || []).find((x: NativeRecord) => x.id === a.questionId);
        const labels = (a.selectedOptionIds || []).map((oid: string) => q?.options?.find((o: NativeRecord) => o.id === oid)?.label || oid);
        return labels.join('; ') + (a.freeformText ? ` (补充: ${a.freeformText})` : '');
      });
      return ev('ask-user', { questions }, `用户选择: ${answers.join(' | ')}`);
    }
    case 'task_v2': {
      const sub = result?.agentId ? loadSubagentSession(dbh, result.agentId) : null;
      let text = '[子代理会话记录未找到]';
      if (sub) {
        for (let i = sub.bubbles.length - 1; i >= 0; i--) {
          const b = sub.bubbles[i];
          if (b && b.header.type === 2 && b.bubble?.text && !b.bubble.toolFormerData) { text = b.bubble.text; break; }
        }
      }
      return ev('subagent', { prompt: args.prompt || args.description || JSON.stringify(args) }, text);
    }
    case 'switch_mode': case 'await':
      return { kind: 'marker', ts, text: `[Cursor UI 事件 ${tf.name}: ${tf.params || ''}]` };
    default:
      return ev('other', { name: tf.name, args }, result ? JSON.stringify(result, null, 1) : String(tf.result ?? ''));
  }
}

export function readSession(cwd: string, composerId: string): ReadSessionResult {
  const dbh = db();
  const session = loadSession(dbh, composerId);
  const events: CanonicalEvent[] = [];
  const skipped: Record<string, number> = {};
  let lastTs = new Date(session.composer.createdAt || Date.now()).toISOString();
  for (const { header, bubble } of session.bubbles) {
    // bubble.createdAt 可能是 ISO 字符串或毫秒数, 统一为 ISO 字符串
    const rawTs = bubble?.createdAt;
    const ts = typeof rawTs === 'number' ? new Date(rawTs).toISOString() : (rawTs || lastTs);
    lastTs = ts;
    if (!bubble) { skipped['记录缺失'] = (skipped['记录缺失'] || 0) + 1; continue; }
    const cap = header.grouping?.capabilityType;
    if (header.type === 1) {
      let text = bubble.text || '';
      const imgs = bubble.context?.selectedImages?.length || 0;
      if (imgs) text += `\n[此消息在 Cursor 中附带 ${imgs} 张图片, 图片数据无法从 Cursor 存储取出]`;
      events.push({ kind: 'user', ts, text });
    } else if (cap === 30) {
      events.push({ kind: 'thinking', ts, text: bubble.thinking?.text || '', signature: bubble.thinking?.signature || '' });
    } else if (cap === 15 && bubble.toolFormerData) {
      events.push(toolEvent(bubble.toolFormerData, ts, dbh));
    } else if (cap === 22) {
      events.push({ kind: 'marker', ts, text: '[Cursor 曾在此处压缩上下文: 此前部分对话在 Cursor 中已被摘要替代]' });
    } else if (bubble.text) {
      events.push({ kind: 'assistant-text', ts, text: bubble.text });
    } else {
      skipped[`capabilityType=${cap}`] = (skipped[`capabilityType=${cap}`] || 0) + 1;
    }
  }
  const explicit = normalizeTitle(session.composer.name) || normalizeTitle(session.composer.subtitle);
  return { title: explicit || titleFromEvents(events) || untitledSession(label, composerId), events, skipped };
}

// ---- 写入: 统一事件流 → bubble 流 (legacy 完整字段模板在 cursor-writer 中) ----

function baseBubble(type: number, bubbleId: string, ts: string): NativeRecord {
  return {
    _v: 3, type,
    approximateLintErrors: [], lints: [], codebaseContextChunks: [], commits: [], pullRequests: [],
    attachedCodeChunks: [], assistantSuggestedDiffs: [], gitDiffs: [], interpreterResults: [], images: [],
    attachedFolders: [], attachedFoldersNew: [],
    bubbleId,
    userResponsesToSuggestedCodeBlocks: [], suggestedCodeBlocks: [], diffsForCompressingFiles: [],
    relevantFiles: [], toolResults: [], notepads: [], capabilities: [], multiFileLinterErrors: [],
    diffHistories: [], recentLocationsHistory: [], recentlyViewedFiles: [],
    isAgentic: false, fileDiffTrajectories: [],
    existedSubsequentTerminalCommand: false, existedPreviousTerminalCommand: false,
    docsReferences: [], webReferences: [], aiWebSearchResults: [],
    requestId: '',
    attachedFoldersListDirResults: [], humanChanges: [], attachedHumanChanges: false,
    summarizedComposers: [], cursorRules: [], cursorCommands: [], cursorCommandsExplicitlySet: false,
    pastChats: [], pastChatsExplicitlySet: false, contextPieces: [], editTrailContexts: [],
    allThinkingBlocks: [], diffsSinceLastApply: [], deletedFiles: [], supportedTools: [],
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    attachedFileCodeChunksMetadataOnly: [], consoleLogs: [], uiElementPicked: [],
    isRefunded: false,
    knowledgeItems: [], documentationSelections: [], externalLinks: [], projectLayouts: [],
    unifiedMode: 2, capabilityContexts: [], todos: [],
    createdAt: ts,
    mcpDescriptors: [], workspaceUris: [], conversationState: '~',
  };
}

interface CursorToolTemplate {
  name: string;
  tool: number;
  args: NativeRecord;
  result: NativeRecord;
  additionalData?: NativeRecord;
}

// 统一词表 → Cursor toolFormerData
function toCursorTool(e: ToolEvent): CursorToolTemplate | null {
  const i = e.input;
  const diffFromEdit = (oldText: unknown, newText: unknown) => ({
    precomputedDiff: {
      lines: [
        ...String(oldText ?? '').split('\n').map((c) => ({ type: 'removed', content: c })),
        ...String(newText ?? '').split('\n').map((c, idx) => ({ type: 'added', content: c, modifiedLineNumber: idx + 1 })),
      ],
      hasChanges: true,
    },
  });
  switch (e.tool) {
    case 'terminal': return { name: 'run_terminal_command_v2', tool: 15, args: { command: i.command, commandDescription: i.description }, result: { output: e.output, exitCode: e.isError ? 1 : 0, rejected: false } };
    case 'read': return { name: 'read_file_v2', tool: 40, args: { path: i.path }, result: { contents: e.output } };
    case 'edit': return { name: 'edit_file_v2', tool: 38, args: { relativeWorkspacePath: i.path }, result: {}, additionalData: diffFromEdit(i.oldText, i.newText) };
    case 'write': return { name: 'edit_file_v2', tool: 38, args: { relativeWorkspacePath: i.path }, result: {}, additionalData: { precomputedDiff: { lines: String(i.content ?? '').split('\n').map((c, idx) => ({ type: 'added', content: c, modifiedLineNumber: idx + 1 })), hasChanges: true } } };
    case 'grep': return { name: 'ripgrep_raw_search', tool: 41, args: { pattern: i.pattern, path: i.path }, result: { raw: e.output } };
    case 'glob': return { name: 'glob_file_search', tool: 42, args: { globPattern: i.pattern, targetDirectory: i.path }, result: { raw: e.output } };
    case 'web-search': return { name: 'web_search', tool: 18, args: { searchTerm: i.query }, result: { references: [{ title: '', url: '', chunk: e.output }] } };
    case 'web-fetch': return { name: 'web_fetch', tool: 57, args: { url: i.url }, result: { url: i.url, markdown: e.output } };
    case 'todo': return { name: 'todo_write', tool: 35, args: { merge: true }, result: { success: true, finalTodos: (i.todos || []).map((t: NativeRecord, idx: number) => ({ content: t.content, status: t.status, id: `todo-${idx}` })) } };
    case 'ask-user': return {
      name: 'ask_question', tool: 51,
      args: { title: '', questions: (i.questions || []).map((q: NativeRecord, qi: number) => ({ id: `q${qi}`, prompt: q.question, options: (q.options || []).map((o: unknown, oi: number) => ({ id: `o${oi}`, label: o })) })) },
      result: { answers: [{ questionId: 'q0', selectedOptionIds: [], freeformText: e.output }] },
    };
    case 'mcp': return {
      name: `mcp-${i.server}-${i.toolName}`, tool: 19,
      args: { name: `${i.server}-${i.toolName}`, args: i.args, providerIdentifier: i.server, toolName: i.toolName },
      result: { result: JSON.stringify({ content: [{ type: 'text', text: e.output }] }) },
    };
    default: return null; // subagent/other → 正文文本
  }
}

export function writeReady(): string | null {
  try {
    assertCursorClosed();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function writeSession(cwd: string, title: string, events: CanonicalEvent[]): WriteSessionResult {
  const bubbles: CursorBubble[] = [];
  const push = (type: number, extra: NativeRecord, grouping: NativeRecord, ts: string) => {
    const bubbleId = randomUUID();
    bubbles.push({
      bubbleId,
      header: { bubbleId, type, createdAt: ts, grouping: { isRenderable: true, ...grouping } },
      data: { ...baseBubble(type, bubbleId, ts), ...extra },
    });
  };
  for (const e of events) {
    switch (e.kind) {
      case 'user':
        push(1, { text: e.text, richText: e.text }, { hasText: true }, e.ts);
        break;
      case 'marker':
        push(1, { text: e.text, richText: e.text }, { hasText: true }, e.ts);
        break;
      case 'assistant-text':
        push(2, { text: e.text, codeBlocks: [], turnDurationMs: 1000 }, { hasText: true, isKeptFinalAiVisibleOutsideWorkedForGroup: true }, e.ts);
        break;
      case 'thinking':
        push(2, { text: '', capabilityType: 30, thinkingStyle: 1, thinking: { text: e.text, signature: e.signature || '' }, thinkingDurationMs: 1000 }, { capabilityType: 30, hasThinking: true }, e.ts);
        break;
      case 'tool': {
        const t = toCursorTool(e);
        if (!t) {
          // subagent / 无对应物工具 → 参数与结果完整保留的正文文本
          push(2, { text: `[工具调用 ${e.origName || e.tool}]\n参数: ${JSON.stringify(e.input)}\n结果: ${e.output || '(无)'}`, codeBlocks: [] }, { hasText: true }, e.ts);
          break;
        }
        const toolCallId = `call_${randomUUID().slice(0, 8)}`;
        push(2, {
          text: '', codeBlocks: [], capabilityType: 15,
          toolFormerData: {
            toolCallId, toolIndex: 0, status: 'completed', name: t.name, tool: t.tool,
            rawArgs: JSON.stringify(t.args), params: JSON.stringify(t.args), result: JSON.stringify(t.result),
            ...(t.additionalData ? { additionalData: t.additionalData } : {}),
          },
        }, { capabilityType: 15, toolFormerTool: t.tool, toolCallId }, e.ts);
        break;
      }
    }
  }
  const composerId = writeCursorSession(cwd, title, bubbles);
  return { id: composerId, resumeHint: `启动 Cursor 打开本项目, 会话历史中选择《${title}》` };
}

export const writeNotes = [
  '写入 Cursor legacy 会话格式 (从 JSON 直接渲染), 只 INSERT 新会话行, 不触碰已有数据',
  '子代理与无 Cursor 对应物的工具调用转为参数结果完整保留的正文文本',
];
