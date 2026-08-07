// Claude Code transcript 接续语义, 移植自 Haleclipse/ClaudeCodeRev:
// - src/utils/sessionStorage.ts (loadTranscriptFile / buildConversationChain / snip / compact)
// - src/utils/conversationRecovery.ts (loadConversationForResume → getLastSessionLog)
//
// JSONL 是追加式消息树: 每条 transcript 消息带 uuid/parentUuid; 回退或重试会留下废弃分支。
// Claude --resume 从「最近一条非 sidechain 消息」沿 parentUuid 回溯到根, 只加载这条活跃链。
// 迁移工具对齐该判定, 不得改写源文件。
import fs from 'node:fs';
import { safeParse } from '../events.ts';
import type { NativeRecord } from '../types.ts';

export interface EffectiveTranscript {
  // 活跃链 (根 → leaf), 含 user/assistant/system/attachment
  messages: NativeRecord[];
  customTitle: string | undefined;
  aiTitle: string;
  // 因不在活跃链上而丢弃的 transcript 消息数 (废弃分支 / sidechain 等)
  abandonedCount: number;
  // 因 snipMetadata.removedUuids 从有效历史中去掉的消息数
  snippedCount: number;
}

export function isTranscriptMessage(entry: NativeRecord): boolean {
  return entry.type === 'user'
    || entry.type === 'assistant'
    || entry.type === 'attachment'
    || entry.type === 'system';
}

export function isCompactBoundary(entry: NativeRecord): boolean {
  return entry.type === 'system' && entry.subtype === 'compact_boundary';
}

function isLegacyProgress(entry: NativeRecord): boolean {
  return entry.type === 'progress' && typeof entry.uuid === 'string';
}

export function loadTranscriptEntries(file: string): NativeRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((line) => line.trim())
    .map((line) => safeParse(line))
    .filter((entry): entry is NativeRecord => entry !== null);
}

function messageTimestamp(msg: NativeRecord): number {
  return Date.parse(String(msg.timestamp || ''));
}

// 找时间戳最新且满足谓词的消息; 时间相同保留先出现者 (与 Claude loader 一致)
function findLatestMessage(
  messages: Iterable<NativeRecord>,
  predicate: (m: NativeRecord) => boolean,
): NativeRecord | undefined {
  let latest: NativeRecord | undefined;
  let maxTime = -Infinity;
  for (const m of messages) {
    if (!predicate(m)) continue;
    const t = messageTimestamp(m);
    if (t > maxTime) {
      maxTime = t;
      latest = m;
    }
  }
  return latest;
}

// 移植 applySnipRemovals: 按边界记录的 removedUuids 删消息, 并把幸存者的 parentUuid 跨过空洞重链
export function applySnipRemovals(messages: Map<string, NativeRecord>): number {
  const toDelete = new Set<string>();
  for (const entry of messages.values()) {
    const removed = entry.snipMetadata?.removedUuids;
    if (!Array.isArray(removed)) continue;
    for (const uuid of removed) {
      if (typeof uuid === 'string') toDelete.add(uuid);
    }
  }
  if (toDelete.size === 0) return 0;

  const deletedParent = new Map<string, string | null>();
  let removedCount = 0;
  for (const uuid of toDelete) {
    const entry = messages.get(uuid);
    if (!entry) continue;
    deletedParent.set(uuid, typeof entry.parentUuid === 'string' ? entry.parentUuid : null);
    messages.delete(uuid);
    removedCount++;
  }

  const resolve = (start: string): string | null => {
    const path: string[] = [];
    let cur: string | null | undefined = start;
    while (cur && toDelete.has(cur)) {
      path.push(cur);
      cur = deletedParent.get(cur);
      if (cur === undefined) {
        cur = null;
        break;
      }
    }
    for (const p of path) deletedParent.set(p, cur ?? null);
    return cur ?? null;
  };

  for (const [uuid, msg] of messages) {
    if (typeof msg.parentUuid !== 'string' || !toDelete.has(msg.parentUuid)) continue;
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) });
  }
  return removedCount;
}

// 移植 applyPreservedSegmentRelinks 的核心: 把 compact 保留段挂回 anchor, 并剪掉边界前未保留消息
export function applyPreservedSegmentRelinks(messages: Map<string, NativeRecord>): void {
  type Seg = { headUuid?: unknown; tailUuid?: unknown; anchorUuid?: unknown };
  let lastSeg: Seg | undefined;
  let lastSegBoundaryIdx = -1;
  let absoluteLastBoundaryIdx = -1;
  const entryIndex = new Map<string, number>();
  let i = 0;
  for (const entry of messages.values()) {
    entryIndex.set(String(entry.uuid), i);
    if (isCompactBoundary(entry)) {
      absoluteLastBoundaryIdx = i;
      const seg = entry.compactMetadata?.preservedSegment;
      if (seg) {
        lastSeg = typeof seg === 'object' ? seg as Seg : {};
        lastSegBoundaryIdx = i;
      }
    }
    i++;
  }
  if (!lastSeg || absoluteLastBoundaryIdx < 0) return;

  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx;
  const preservedUuids = new Set<string>();
  if (segIsLive) {
    const { headUuid, tailUuid, anchorUuid } = lastSeg;
    if (
      typeof headUuid !== 'string' || !headUuid
      || typeof tailUuid !== 'string' || !tailUuid
      || typeof anchorUuid !== 'string' || !anchorUuid
    ) return;

    const walkSeen = new Set<string>();
    let cur = messages.get(tailUuid);
    let reachedHead = false;
    while (cur && !walkSeen.has(String(cur.uuid))) {
      walkSeen.add(String(cur.uuid));
      preservedUuids.add(String(cur.uuid));
      if (cur.uuid === headUuid) {
        reachedHead = true;
        break;
      }
      cur = typeof cur.parentUuid === 'string' ? messages.get(cur.parentUuid) : undefined;
    }
    if (!reachedHead) return;

    const head = messages.get(headUuid);
    if (head) {
      messages.set(headUuid, { ...head, parentUuid: anchorUuid });
    }
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === anchorUuid && uuid !== headUuid) {
        messages.set(uuid, { ...msg, parentUuid: tailUuid });
      }
    }
  }

  const toDelete: string[] = [];
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid);
    if (idx !== undefined && idx < absoluteLastBoundaryIdx && !preservedUuids.has(uuid)) {
      toDelete.push(uuid);
    }
  }
  for (const uuid of toDelete) messages.delete(uuid);
}

// 移植 recoverOrphanedParallelToolResults: 并行 tool_use 写成多条同 message.id 的 assistant, 单链 walk 会丢兄弟与对应 tool_result
function recoverOrphanedParallelToolResults(
  messages: Map<string, NativeRecord>,
  chain: NativeRecord[],
  seen: Set<string>,
): NativeRecord[] {
  const chainAssistants = chain.filter((m) => m.type === 'assistant');
  if (chainAssistants.length === 0) return chain;

  const anchorByMsgId = new Map<string, NativeRecord>();
  for (const a of chainAssistants) {
    const mid = a.message?.id;
    if (typeof mid === 'string') anchorByMsgId.set(mid, a);
  }

  const siblingsByMsgId = new Map<string, NativeRecord[]>();
  const toolResultsByAsst = new Map<string, NativeRecord[]>();
  for (const m of messages.values()) {
    if (m.type === 'assistant' && typeof m.message?.id === 'string') {
      const group = siblingsByMsgId.get(m.message.id);
      if (group) group.push(m);
      else siblingsByMsgId.set(m.message.id, [m]);
    } else if (
      m.type === 'user'
      && typeof m.parentUuid === 'string'
      && Array.isArray(m.message?.content)
      && m.message.content.some((b: NativeRecord) => b?.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(m.parentUuid);
      if (group) group.push(m);
      else toolResultsByAsst.set(m.parentUuid, [m]);
    }
  }

  const processedGroups = new Set<string>();
  const inserts = new Map<string, NativeRecord[]>();
  for (const asst of chainAssistants) {
    const msgId = asst.message?.id;
    if (typeof msgId !== 'string' || processedGroups.has(msgId)) continue;
    processedGroups.add(msgId);

    const group = siblingsByMsgId.get(msgId) ?? [asst];
    const orphanedSiblings = group.filter((s) => !seen.has(String(s.uuid)));
    const orphanedTRs: NativeRecord[] = [];
    for (const member of group) {
      const trs = toolResultsByAsst.get(String(member.uuid));
      if (!trs) continue;
      for (const tr of trs) {
        if (!seen.has(String(tr.uuid))) orphanedTRs.push(tr);
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) continue;

    orphanedSiblings.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    orphanedTRs.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));

    const anchor = anchorByMsgId.get(msgId)!;
    const recovered = [...orphanedSiblings, ...orphanedTRs];
    for (const r of recovered) seen.add(String(r.uuid));
    inserts.set(String(anchor.uuid), recovered);
  }

  if (inserts.size === 0) return chain;
  const result: NativeRecord[] = [];
  for (const m of chain) {
    result.push(m);
    const toInsert = inserts.get(String(m.uuid));
    if (toInsert) result.push(...toInsert);
  }
  return result;
}

// 移植 buildConversationChain: 从 leaf 沿 parentUuid 回溯到根, 再恢复并行 tool 孤儿
export function buildConversationChain(
  messages: Map<string, NativeRecord>,
  leafMessage: NativeRecord,
): NativeRecord[] {
  const transcript: NativeRecord[] = [];
  const seen = new Set<string>();
  let current: NativeRecord | undefined = leafMessage;
  while (current) {
    const id = String(current.uuid);
    if (seen.has(id)) break;
    seen.add(id);
    transcript.push(current);
    current = typeof current.parentUuid === 'string'
      ? messages.get(current.parentUuid)
      : undefined;
  }
  transcript.reverse();
  return recoverOrphanedParallelToolResults(messages, transcript, seen);
}

function extractTitles(entries: NativeRecord[]): { customTitle: string | undefined; aiTitle: string } {
  let customTitle: string | undefined;
  let aiTitle = '';
  for (const entry of entries) {
    if (entry.type === 'custom-title' && entry.customTitle != null) {
      customTitle = String(entry.customTitle);
    } else if (entry.type === 'ai-title' && entry.aiTitle != null) {
      aiTitle = String(entry.aiTitle);
    }
  }
  return { customTitle, aiTitle };
}

// 无 uuid 的旧夹具 / 简化记录: 保持线性顺序, 但仍跳过 isSidechain
function linearFallback(entries: NativeRecord[], customTitle: string | undefined, aiTitle: string): EffectiveTranscript {
  const messages = entries.filter((e) => isTranscriptMessage(e) && !e.isSidechain);
  const sidechainCount = entries.filter((e) => isTranscriptMessage(e) && e.isSidechain).length;
  return { messages, customTitle, aiTitle, abandonedCount: sidechainCount, snippedCount: 0 };
}

// resume 用的有效 transcript: preserved compact → snip → 从最近非 sidechain leaf 回溯
// 顺序与 ClaudeCodeRev loadTranscriptFile 一致 (先 compact relink, 再 snip 删链)
export function effectiveTranscript(entries: NativeRecord[]): EffectiveTranscript {
  const { customTitle, aiTitle } = extractTitles(entries);

  const progressBridge = new Map<string, string | null>();
  const messages = new Map<string, NativeRecord>();
  let transcriptWithUuid = 0;

  for (const entry of entries) {
    if (isLegacyProgress(entry)) {
      const parent = typeof entry.parentUuid === 'string' ? entry.parentUuid : null;
      progressBridge.set(
        entry.uuid,
        parent && progressBridge.has(parent) ? (progressBridge.get(parent) ?? null) : parent,
      );
      continue;
    }
    if (!isTranscriptMessage(entry) || typeof entry.uuid !== 'string') continue;
    transcriptWithUuid++;
    const copy = { ...entry };
    if (typeof copy.parentUuid === 'string' && progressBridge.has(copy.parentUuid)) {
      copy.parentUuid = progressBridge.get(copy.parentUuid) ?? null;
    }
    messages.set(copy.uuid, copy);
  }

  if (transcriptWithUuid === 0) {
    return linearFallback(entries, customTitle, aiTitle);
  }

  applyPreservedSegmentRelinks(messages);
  const snippedCount = applySnipRemovals(messages);

  // 与 getLastSessionLog 一致: 最近一条非 sidechain 消息作 leaf
  const leaf = findLatestMessage(messages.values(), (m) => !m.isSidechain);
  if (!leaf) {
    return { messages: [], customTitle, aiTitle, abandonedCount: messages.size, snippedCount };
  }

  const chain = buildConversationChain(messages, leaf);
  const onChain = new Set(chain.map((m) => String(m.uuid)));
  // abandoned: 仍在 map 但不在活跃链上; snipped 已删出 map, 单独报告
  return {
    messages: chain,
    customTitle,
    aiTitle,
    abandonedCount: Math.max(0, messages.size - onChain.size),
    snippedCount,
  };
}

export function loadEffectiveTranscript(file: string): EffectiveTranscript {
  return effectiveTranscript(loadTranscriptEntries(file));
}
