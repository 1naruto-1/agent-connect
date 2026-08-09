// Codex rollout 接续语义, 对齐 openai/codex resume 的「丢弃已回退轮次」结果:
// - 参考 core/src/session/rollout_reconstruction.rs / thread_rollout_truncation.rs /
//   app-server-protocol/.../thread_history.rs 的 ThreadRolledBack 行为
// - legacy / paginated event_msg 是首选展示边界; 缺失时回退到非上下文
//   ResponseItem::UserMessage 或 inter-agent 记录; 双轨先后顺序不同也只保留一个逻辑轮次
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
  text: string;
  eventIndex?: number;
  responseIndex?: number;
  interAgentIndex?: number;
}

const CONTEXTUAL_USER_PREFIXES = [
  '# agents.md instructions', '<user_instructions', '<environment_context', '<additional_context', '<skill',
  '<user_shell_command', '<turn_aborted', '<subagent_notification', '<internal_model_context',
  '<recommended_plugins', '<local-command-caveat', '<system-reminder', '<hook_prompt',
  '<permissions instructions', '<model_switch', '<apps_instructions', '<collaboration_mode',
  '<multi_agent_mode', '<environments_instructions', '<git_attribution', '<plugins_instructions',
  '<realtime_conversation', '<skills_instructions', '<tools', '<personality_spec',
  '<token_budget', '<context_window', '<rollout_budget',
  'warning: apply_patch was requested via ',
  'warning: your account was flagged for potentially high-risk cyber activity',
  'warning: the maximum number of unified exec processes you can keep open is',
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

function isInterAgentMetadata(line: NativeRecord): boolean {
  return line.type === 'inter_agent_communication_metadata'
    && !!line.payload
    && typeof line.payload === 'object';
}

function isAgentMessageResponse(line: NativeRecord): boolean {
  return line.type === 'response_item'
    && line.payload?.type === 'agent_message';
}

export function isInterAgentCommunication(line: NativeRecord): boolean {
  return (line.type === 'inter_agent_communication'
      && !!line.payload
      && typeof line.payload === 'object')
    || isAgentMessageResponse(line);
}

export function interAgentMessageText(line: NativeRecord): string {
  if (line.type === 'inter_agent_communication') return String(line.payload?.content ?? '').trim();
  if (!isAgentMessageResponse(line) || !Array.isArray(line.payload.content)) return '';
  return line.payload.content
    .map((part: NativeRecord) => typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isBarrierLine(line: NativeRecord): boolean {
  if (line.type === 'compacted' || isThreadRolledBack(line)) return true;
  if (line.type === 'response_item') {
    const pType = String(line.payload?.type || '');
    if (['reasoning', 'custom_tool_call', 'function_call', 'custom_tool_call_output', 'function_call_output'].includes(pType)) {
      return true;
    }
    if (pType === 'message') {
      return line.payload?.role !== 'user';
    }
    return true;
  }
  if (line.type === 'event_msg') {
    const pType = String(line.payload?.type || '');
    return ['agent_message', 'agent_reasoning', 'item_completed', 'turn_started', 'turn_complete', 'turn_aborted'].includes(pType);
  }
  return false;
}

interface PendingUser {
  index: number;
  line: NativeRecord;
  kind: 'event' | 'response';
  text: string;
}

// 识别真实用户轮次并双向去重 event_msg + response_item; 同时兼容当前与 legacy inter-agent 记录。
export function userTurnBoundaries(lines: NativeRecord[]): UserTurnBoundary[] {
  const boundaries: UserTurnBoundary[] = [];
  let pending: PendingUser | null = null;
  let pendingInterAgentMetadata: { index: number; line: NativeRecord } | null = null;

  const finalizePending = () => {
    if (!pending) return;
    if (pending.kind === 'event') {
      boundaries.push({
        index: pending.index,
        line: pending.line,
        kind: 'event',
        eventIndex: pending.index,
        text: pending.text,
      });
    } else {
      boundaries.push({
        index: pending.index,
        line: pending.line,
        kind: 'response',
        responseIndex: pending.index,
        text: pending.text,
      });
    }
    pending = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;

    if (isInterAgentMetadata(line)) {
      finalizePending();
      pendingInterAgentMetadata = { index, line };
      continue;
    }

    const interAgentMetadata = pendingInterAgentMetadata;
    pendingInterAgentMetadata = null;
    if (isInterAgentCommunication(line)) {
      finalizePending();
      const currentAgentMessage = isAgentMessageResponse(line);
      const start = currentAgentMessage && interAgentMetadata ? interAgentMetadata : { index, line };
      boundaries.push({
        index: start.index,
        line: start.line,
        kind: 'inter-agent',
        text: interAgentMessageText(line),
        ...(currentAgentMessage ? { interAgentIndex: index } : {}),
      });
      continue;
    }

    if (isUserMessageEvent(line)) {
      const text = userMessageText(line.payload || {});
      if (pending) {
        if (pending.kind === 'response') {
          const normPending = pending.text.trim();
          const normCurr = text.trim();
          if (!normPending || !normCurr || normPending === normCurr) {
            const eventText = text || pending.text;
            boundaries.push({
              index: pending.index,
              line: pending.line,
              kind: 'event',
              eventIndex: index,
              responseIndex: pending.index,
              text: eventText,
            });
            pending = null;
            continue;
          }
        }
        finalizePending();
      }
      pending = { index, line, kind: 'event', text };
      continue;
    }

    if (isResponseUserMessage(line)) {
      if (isContextualResponseUser(line)) continue;
      const text = responseUserMessageText(line);
      if (pending) {
        if (pending.kind === 'event') {
          const normPending = pending.text.trim();
          const normCurr = text.trim();
          if (!normPending || !normCurr || normPending === normCurr) {
            const eventText = pending.text || text;
            boundaries.push({
              index: pending.index,
              line: pending.line,
              kind: 'event',
              eventIndex: pending.index,
              responseIndex: index,
              text: eventText,
            });
            pending = null;
            continue;
          }
        }
        finalizePending();
      }
      pending = { index, line, kind: 'response', text };
      continue;
    }

    if (isBarrierLine(line)) {
      finalizePending();
    }
  }

  finalizePending();
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
