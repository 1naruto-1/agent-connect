// 统一事件层: 所有适配器读写的中间格式
//
// 事件流 = 有序数组, 每个事件:
//   {kind:'user', ts, text}
//   {kind:'assistant-text', ts, text}
//   {kind:'thinking', ts, text, signature}
//   {kind:'tool', ts, tool, input, output, isError, origName}
//   {kind:'marker', ts, text}          — 元信息 (压缩点/迁移说明/不可转换事件占位)
//
// 统一工具词表 (tool 字段) 与 input 形状:
//   terminal   {command, description?}
//   read       {path}
//   edit       {path, oldText, newText}
//   write      {path, content}
//   glob       {pattern, path?}
//   grep       {pattern, path?}
//   web-search {query}
//   web-fetch  {url}
//   todo       {todos:[{content,status}]}
//   ask-user   {questions:[{question, options:[label]}]}
//   subagent   {prompt}
//   mcp        {server, toolName, args}
//   other      {name, args}            — 无词表对应, 原名原参保留
// output 一律为字符串 (结果全文), 无损原则: 默认不截断不丢弃

export function safeParse(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 按工具名把未知来源的调用还原为统一词表 (跨工具多跳迁移时保持工具身份)
export function canonicalToolFromName(name, args = {}) {
  switch (String(name || '').toLowerCase()) {
    case 'shell': case 'bash': case 'terminal':
      return args.command ? { tool: 'terminal', input: { command: args.command, description: args.description } } : null;
    case 'read': case 'read_file':
      return { tool: 'read', input: { path: args.path || args.file_path || '' } };
    case 'edit':
      return { tool: 'edit', input: { path: args.path || args.file_path || '', oldText: args.oldText ?? args.old_string ?? '', newText: args.newText ?? args.new_string ?? '' } };
    case 'write':
      return { tool: 'write', input: { path: args.path || args.file_path || '', content: args.content ?? '' } };
    case 'glob': case 'find': case 'glob_file_search':
      return { tool: 'glob', input: { pattern: args.pattern || args.glob || args.globPattern || '', path: args.path || args.targetDirectory } };
    case 'grep': case 'ripgrep_raw_search':
      return { tool: 'grep', input: { pattern: args.pattern || '', path: args.path } };
    case 'web_search': case 'websearch':
      return { tool: 'web-search', input: { query: args.query || args.searchTerm || '' } };
    case 'web_fetch': case 'webfetch':
      return { tool: 'web-fetch', input: { url: args.url || '' } };
    case 'todo_write': case 'todowrite':
      return { tool: 'todo', input: { todos: args.todos || [] } };
    case 'ask_user': case 'ask_question': case 'askuserquestion':
      return { tool: 'ask-user', input: { questions: args.questions || [] } };
    case 'task':
      return { tool: 'subagent', input: { prompt: args.prompt || '' } };
    default:
      return null;
  }
}

// 统计事件流, 供报告与迁移概要使用
export function analyzeEvents(events, skipped = {}) {
  const s = {
    total: events.length,
    user: 0, assistantText: 0, thinking: 0, markers: 0,
    tools: {},        // 词表工具 → 次数
    mcp: {},          // mcp 工具名 → 次数
    other: {},        // 无对应物工具 → 次数
    subagents: 0,
    skipped,          // 源工具的内部行 (非对话内容)
  };
  for (const e of events) {
    if (e.kind === 'user') s.user++;
    else if (e.kind === 'assistant-text') s.assistantText++;
    else if (e.kind === 'thinking') s.thinking++;
    else if (e.kind === 'marker') s.markers++;
    else if (e.kind === 'tool') {
      if (e.tool === 'mcp') s.mcp[`${e.input.server}/${e.input.toolName}`] = (s.mcp[`${e.input.server}/${e.input.toolName}`] || 0) + 1;
      else if (e.tool === 'other') s.other[e.input.name] = (s.other[e.input.name] || 0) + 1;
      else if (e.tool === 'subagent') s.subagents++;
      else s.tools[e.tool] = (s.tools[e.tool] || 0) + 1;
    }
  }
  return s;
}

const fmtMap = (m) => Object.entries(m).map(([k, v]) => `${k}×${v}`).join(', ');

// 迁移概要 (一行) + 报告正文
export function summaryLine(stats) {
  const parts = [
    `用户消息×${stats.user}`, `助手正文×${stats.assistantText}`,
    stats.thinking && `思考块×${stats.thinking}`,
    Object.keys(stats.tools).length && `工具调用 ${fmtMap(stats.tools)}`,
    Object.keys(stats.mcp).length && `MCP ${fmtMap(stats.mcp)}`,
    stats.subagents && `子代理×${stats.subagents}`,
    Object.keys(stats.other).length && `无对应物工具 ${fmtMap(stats.other)}`,
    stats.markers && `标记×${stats.markers}`,
  ].filter(Boolean);
  return parts.join(', ');
}

export function renderReport({ source, target, title, stats, notes }) {
  const L = [
    `# 会话迁移报告: ${source} → ${target}`,
    '',
    `- 会话: **${title}**`,
    `- ${summaryLine(stats)}`,
    '',
    `## 处理说明 (默认策略: 全量保留, 不摘要不丢弃)`,
    '',
  ];
  for (const n of notes) L.push(`- ${n}`);
  if (Object.keys(stats.skipped).length) {
    L.push(`- 源工具内部状态行 (非对话内容, 不迁移): ${fmtMap(stats.skipped)}`);
  }
  L.push('');
  return L.join('\n');
}
