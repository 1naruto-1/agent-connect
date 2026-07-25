import type { CanonicalEvent, CanonicalTool, MigrationStats, NativeRecord, ToolInput } from './types.ts';

export interface CanonicalToolCall { tool: CanonicalTool; input: ToolInput; }

export function safeParse(text: unknown): NativeRecord | null {
  if (text == null) return null;
  if (typeof text === 'object' && !Array.isArray(text)) return text as NativeRecord;
  if (typeof text !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as NativeRecord : null;
  } catch { return null; }
}

export function canonicalToolFromName(name: string | null | undefined, args: ToolInput = {}): CanonicalToolCall | null {
  switch (String(name || '').toLowerCase()) {
    case 'shell': case 'bash': case 'terminal': return args.command ? { tool: 'terminal', input: { command: args.command, description: args.description } } : null;
    case 'read': case 'read_file': return { tool: 'read', input: { path: args.path || args.file_path || '' } };
    case 'edit': return { tool: 'edit', input: { path: args.path || args.file_path || '', oldText: args.oldText ?? args.old_string ?? '', newText: args.newText ?? args.new_string ?? '' } };
    case 'write': return { tool: 'write', input: { path: args.path || args.file_path || '', content: args.content ?? '' } };
    case 'glob': case 'find': case 'glob_file_search': return { tool: 'glob', input: { pattern: args.pattern || args.glob || args.globPattern || '', path: args.path || args.targetDirectory } };
    case 'grep': case 'ripgrep_raw_search': return { tool: 'grep', input: { pattern: args.pattern || '', path: args.path } };
    case 'web_search': case 'websearch': return { tool: 'web-search', input: { query: args.query || args.searchTerm || '' } };
    case 'web_fetch': case 'webfetch': return { tool: 'web-fetch', input: { url: args.url || '' } };
    case 'todo_write': case 'todowrite': return { tool: 'todo', input: { todos: args.todos || [] } };
    case 'ask_user': case 'ask_question': case 'askuserquestion': return { tool: 'ask-user', input: { questions: args.questions || [] } };
    case 'task': return { tool: 'subagent', input: { prompt: args.prompt || '' } };
    default: return null;
  }
}

export function analyzeEvents(events: CanonicalEvent[], skipped: Record<string, number> = {}): MigrationStats {
  const stats: MigrationStats = { total: events.length, user: 0, assistantText: 0, thinking: 0, markers: 0, tools: {}, mcp: {}, other: {}, subagents: 0, skipped };
  for (const event of events) {
    if (event.kind === 'user') stats.user++;
    else if (event.kind === 'assistant-text') stats.assistantText++;
    else if (event.kind === 'thinking') stats.thinking++;
    else if (event.kind === 'marker') stats.markers++;
    else if (event.tool === 'mcp') {
      const key = `${String(event.input.server || '')}/${String(event.input.toolName || '')}`;
      stats.mcp[key] = (stats.mcp[key] || 0) + 1;
    } else if (event.tool === 'other') {
      const key = String(event.input.name || 'unknown');
      stats.other[key] = (stats.other[key] || 0) + 1;
    } else if (event.tool === 'subagent') stats.subagents++;
    else stats.tools[event.tool] = (stats.tools[event.tool] || 0) + 1;
  }
  return stats;
}

const fmt = (value: Record<string, number>): string => Object.entries(value).map(([key, count]) => `${key}×${count}`).join(', ');

export function summaryLine(stats: MigrationStats): string {
  return [
    `用户消息×${stats.user}`, `助手正文×${stats.assistantText}`,
    stats.thinking ? `思考块×${stats.thinking}` : '', Object.keys(stats.tools).length ? `工具调用 ${fmt(stats.tools)}` : '',
    Object.keys(stats.mcp).length ? `MCP ${fmt(stats.mcp)}` : '', stats.subagents ? `子代理×${stats.subagents}` : '',
    Object.keys(stats.other).length ? `无对应物工具 ${fmt(stats.other)}` : '', stats.markers ? `标记×${stats.markers}` : '',
  ].filter(Boolean).join(', ');
}

export function renderReport(input: { source: string; target: string; title: string; stats: MigrationStats; notes: string[] }): string {
  const lines = [`# 会话迁移报告: ${input.source} → ${input.target}`, '', `- 会话: **${input.title}**`, `- ${summaryLine(input.stats)}`, '', '## 处理说明（默认策略：全量保留，不摘要不丢弃）', ''];
  for (const note of input.notes) lines.push(`- ${note}`);
  if (Object.keys(input.stats.skipped).length) lines.push(`- 源工具内部状态行（非对话内容，不迁移）：${fmt(input.stats.skipped)}`);
  lines.push('');
  return lines.join('\n');
}
