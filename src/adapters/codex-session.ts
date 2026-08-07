// Codex rollout 接续语义, 对齐 openai/codex resume 的「丢弃已回退轮次」结果:
// - 参考 core/src/session/rollout_reconstruction.rs / thread_rollout_truncation.rs /
//   app-server-protocol/.../thread_history.rs 的 ThreadRolledBack 行为
// - 切点按本适配器的展示解析: event_msg.user_message / item_completed(UserMessage)
//   (上游 truncation 以 ResponseItem→TurnItem::UserMessage 为边界; 本读取器把
//   response_item role=user 视为注入上下文并跳过, 故用 event_msg 切以免留下孤儿用户行)
//
// Rollout 是追加式 JSONL: 回退会追加 event_msg.thread_rolled_back, 压缩会追加 type=compacted。
// 迁移只加载回退后的有效历史, 不得改写源文件。
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

// 用户轮次边界 (适配器对齐): legacy user_message 与分页 item_completed(UserMessage)
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

// 对齐 drop_last_n_user_turns 的结果, 切点用 event_msg 用户边界 (见文件头说明):
// 正向扫描; 遇到 thread_rolled_back(n) 时, 从「倒数第 n 个 event_msg 用户消息」起截断有效前缀。
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

// 有效 rollout: 应用 ThreadRolledBack; 压缩仍保留全文 + marker (迁移全量策略, 异于 resume 替换历史)
export function effectiveRolloutLines(lines: NativeRecord[]): EffectiveRollout {
  return applyThreadRollbacks(lines);
}
