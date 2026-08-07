// Codex rollout 接续语义, 移植自 openai/codex:
// - core/src/session/rollout_reconstruction.rs (resume 重建历史)
// - core/src/thread_rollout_truncation.rs (ThreadRolledBack 对用户轮次的截断)
// - app-server-protocol/.../thread_history.rs (UI 侧同样丢弃被回退的 turn)
//
// Rollout 是追加式 JSONL: 回退会追加 event_msg.thread_rolled_back, 压缩会追加 type=compacted。
// Codex resume 只加载回退后的有效历史; 迁移工具对齐该判定, 不得改写源文件。
import fs from 'node:fs';
import { safeParse } from '../events.ts';
import type { NativeRecord } from '../types.ts';

export interface EffectiveRollout {
  lines: NativeRecord[];
  // 因 ThreadRolledBack 从有效历史中去掉的记录数
  rolledBackLines: number;
  // 累计回退的用户轮次数 (多次 thread_rolled_back 之和, 按实际丢弃封顶)
  rolledBackTurns: number;
}

// 解析 rollout JSONL; 坏行跳过
export function loadRolloutLines(file: string): NativeRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((line) => line.trim())
    .map((line) => safeParse(line))
    .filter((entry): entry is NativeRecord => entry !== null);
}

// TurnItem 在 JSON 中为 PascalCase 变体名 (见 protocol items.rs / TUI fixtures)
function isUserMessageItem(item: unknown): item is NativeRecord {
  return !!item && typeof item === 'object' && (item as NativeRecord).type === 'UserMessage';
}

// 用户轮次边界: 与 Codex list/resume 一致, 同时认 legacy user_message 与分页 item_completed
export function isUserMessageEvent(line: NativeRecord): boolean {
  if (line.type !== 'event_msg') return false;
  const p = line.payload;
  if (!p || typeof p !== 'object') return false;
  if (p.type === 'user_message') return true;
  return p.type === 'item_completed' && isUserMessageItem(p.item);
}

// 从 user_message / item_completed(UserMessage) 取出展示文本
export function userMessageText(payload: NativeRecord): string {
  if (payload.type === 'user_message') return String(payload.message ?? '');
  if (payload.type === 'item_completed' && isUserMessageItem(payload.item)) {
    const content = payload.item.content;
    if (!Array.isArray(content)) return '';
    return content.map((part: NativeRecord) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

export function isThreadRolledBack(line: NativeRecord): boolean {
  return line.type === 'event_msg' && line.payload?.type === 'thread_rolled_back';
}

export function compactedMessage(line: NativeRecord): string {
  if (line.type !== 'compacted') return '';
  const payload = line.payload && typeof line.payload === 'object' ? line.payload : line;
  return String(payload.message ?? '').trim();
}

// 移植 user_message_positions_in_rollout + drop_last_n_user_turns 的行级等价物:
// 正向扫描; 遇到 thread_rolled_back(n) 时, 从「倒数第 n 个用户消息」起截断有效前缀。
// 用户边界用 event_msg (user_message / item_completed), 与本适配器的展示解析一致。
export function applyThreadRollbacks(lines: NativeRecord[]): EffectiveRollout {
  const effective: NativeRecord[] = [];
  let rolledBackTurns = 0;

  for (const line of lines) {
    if (isThreadRolledBack(line)) {
      const raw = Number(line.payload?.num_turns ?? 0);
      const numTurns = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      if (numTurns === 0) continue;

      const userStarts: number[] = [];
      for (let i = 0; i < effective.length; i++) {
        if (isUserMessageEvent(effective[i]!)) userStarts.push(i);
      }
      if (userStarts.length === 0) continue;

      const dropCount = Math.min(numTurns, userStarts.length);
      const cutIdx = userStarts[userStarts.length - dropCount]!;
      effective.length = cutIdx;
      rolledBackTurns += dropCount;
      continue;
    }
    effective.push(line);
  }

  return {
    lines: effective,
    rolledBackLines: Math.max(0, lines.length - effective.length),
    rolledBackTurns,
  };
}

// resume 用的有效 rollout: 当前仅应用 ThreadRolledBack (压缩仍保留全文 + marker, 与迁移全量策略一致)
export function effectiveRolloutLines(lines: NativeRecord[]): EffectiveRollout {
  return applyThreadRollbacks(lines);
}
