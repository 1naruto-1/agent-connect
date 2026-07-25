// 迁移核心: 读取 → 报告 → 写入
import path from 'node:path';
import fs from 'node:fs';
import { getAdapter } from './adapters/index.js';
import { analyzeEvents, summaryLine, renderReport } from './events.js';

export function migrate(cwd, sourceId, sessionId, targetId) {
  const source = getAdapter(sourceId);
  const target = getAdapter(targetId);
  if (sourceId === targetId) throw new Error('源与目标是同一个工具');

  const notReady = target.writeReady();
  if (notReady) throw new Error(notReady);

  const { title, events, skipped } = source.readSession(cwd, sessionId);
  const stats = analyzeEvents(events, skipped);

  // 迁移来源标记, 让目标端模型知道上下文出处
  const provenance = {
    kind: 'marker',
    ts: events[0]?.ts || new Date().toISOString(),
    text: `[agent-connect] 本会话由 ${source.label} 会话《${title}》迁移而来, 以下为该会话的原始记录 (工具调用已映射为本工具等价形式)。请基于这些上下文继续工作。`,
  };
  const result = target.writeSession(cwd, title, [provenance, ...events]);

  // 报告落盘
  const outDir = path.join(cwd, '.agent-connect');
  fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, `report-${sourceId}-to-${targetId}-${sessionId.slice(0, 8)}.md`);
  fs.writeFileSync(reportFile, renderReport({
    source: source.label, target: target.label, title, stats,
    notes: target.writeNotes || [],
  }));

  return { title, stats, summary: summaryLine(stats), reportFile, targetId: result.id, resumeHint: result.resumeHint };
}
