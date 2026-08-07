// Codex rollout 接续语义, 对齐 openai/codex resume 的「丢弃已回退轮次」结果:
// - 参考 core/src/session/rollout_reconstruction.rs / thread_rollout_truncation.rs /
//   app-server-protocol/.../thread_history.rs 的 ThreadRolledBack 行为
// - legacy / paginated event_msg 是首选展示边界; 缺失时回退到非上下文
//   ResponseItem::UserMessage 或 inter_agent_communication, 并去重双轨用户记录
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

export interface UserTurnBoundary {
  index: number;
  line: NativeRecord;
  kind: 'event' | 'response' | 'inter-agent';
}

const CONTEXTUAL_USER_PREFIXES = [
  '<user_instructions', '<environment_context', '<additional_context', '<skill',
  '<user_shell_command', '<turn_aborted', '<subagent_notification', '<internal_model_context',
  '<recommended_plugins', '<local-command-caveat', '<system-reminder', '<hook_prompt',
  '<permissions instructions', '<model_switch', '<apps_instructions', '<collaboration_mode',
  '<multi_agent_mode', '<environments_instructions', '<git_attribution', '<plugins_instructions',
  '<realtime_conversation', '<skills_instructions', '<tools', '<personality_spec',
  '<token_budget', '<context_window', '<rollout_budget',
];

export function isResponseUserMessage(line: NativeRecord): boolean {
  return line.type === 'response_item'
    && line.payload?.type === 'message'
    && line.payload?.role === 'user';
}

export function responseUserMessageText(line: NativeRecord): string {
  if (!isResponseUserMessage(line) || !Array.isArray(line.payload.content)) return '';
  return line.payload.content.map((part: NativeRecord) => {
    if (typeof part === 'string') return part;
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('');
}

function isContextualResponseUser(line: NativeRecord): boolean {
  if (!isResponseUserMessage(line) || !Array.isArray(line.payload.content)) return false;
  return line.payload.content.some((part: NativeRecord) => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return false;
    const text = part.text.trimStart().toLowerCase();
    return CONTEXTUAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
  });
}

export function isInterAgentCommunication(line: NativeRecord): boolean {
  return line.type === 'inter_agent_communication'
    && !!line.payload
    && typeof line.payload === 'object';
}

export function interAgentMessageText(line: NativeRecord): string {
  return isInterAgentCommunication(line) ? String(line.payload.content ?? '').trim() : '';
}

function closesPendingEventTwin(line: NativeRecord): boolean {
  if (line.type === 'response_item') return true;
  if (line.type === 'compacted' || isThreadRolledBack(line)) return true;
  if (line.type !== 'event_msg') return false;
  return ['agent_message', 'agent_reasoning', 'item_completed', 'turn_started', 'turn_complete', 'turn_aborted']
    .includes(String(line.payload?.type || ''));
}

// 识别真实用户轮次并去重 event_msg + response_item 双轨记录。
export function userTurnBoundaries(lines: NativeRecord[]): UserTurnBoundary[] {
  const boundaries: UserTurnBoundary[] = [];
  let pendingEventTwin = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (isUserMessageEvent(line)) {
      boundaries.push({ index, line, kind: 'event' });
      pendingEventTwin = true;
      continue;
    }
    if (isResponseUserMessage(line)) {
      if (isContextualResponseUser(line)) continue;
      if (pendingEventTwin) {
        pendingEventTwin = false;
        continue;
      }
      boundaries.push({ index, line, kind: 'response' });
      continue;
    }
    if (isInterAgentCommunication(line)) {
      boundaries.push({ index, line, kind: 'inter-agent' });
      pendingEventTwin = false;
      continue;
    }
    if (pendingEventTwin && closesPendingEventTwin(line)) pendingEventTwin = false;
  }
  return boundaries;
}

export function isThreadRolledBack(line: NativeRecord): boolean {
  return line.type === 'event_msg' && line.payload?.type === 'thread_rolled_back';
}

export function compactedMessage(line: NativeRecord): string {
  if (line.type !== 'compacted') return '';
  const payload = line.payload && typeof line.payload === 'object' ? line.payload : line;
  return String(payload.message ?? '').trim();
}

// 正向扫描; 每个 rollback 都作用于当前有效前缀的真实用户轮次。
export function applyThreadRollbacks(lines: NativeRecord[]): EffectiveRollout {
  const effective: NativeRecord[] = [];
  let rolledBackLines = 0;
  let rolledBackTurns = 0;

  for (const line of lines) {
    if (isThreadRolledBack(line)) {
      const raw = line.payload?.num_turns;
      const numTurns = typeof raw === 'number'
        && Number.isInteger(raw)
        && raw > 0
        && raw <= 0xffff_ffff
        ? raw
        : 0;
      if (numTurns === 0) continue;

      const boundaries = userTurnBoundaries(effective);
      if (boundaries.length === 0) continue;

      const dropCount = Math.min(numTurns, boundaries.length);
      const cutIdx = boundaries[boundaries.length - dropCount]!.index;
      rolledBackLines += effective.length - cutIdx;
      effective.length = cutIdx;
      rolledBackTurns += dropCount;
      continue;
    }
    effective.push(line);
  }

  return { lines: effective, rolledBackLines, rolledBackTurns };
}

// 有效 rollout: 应用 ThreadRolledBack; 压缩仍保留全文 + marker (迁移全量策略, 异于 resume 替换历史)
export function effectiveRolloutLines(lines: NativeRecord[]): EffectiveRollout {
  return applyThreadRollbacks(lines);
}
