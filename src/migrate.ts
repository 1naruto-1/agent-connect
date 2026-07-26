import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter } from './adapters/index.ts';
import { analyzeEvents, renderReport, summaryLine } from './events.ts';
import { reportFilePath } from './platform/paths.ts';
import type { Adapter, AdapterId, MigrationResult } from './types.ts';

export interface MigrateOptions {
  getAdapter?: (id: AdapterId) => Adapter;
  reportFile?: string;
}

export function migrate(cwd: string, sourceId: AdapterId, sessionId: string, targetId: AdapterId, options: MigrateOptions = {}): MigrationResult {
  const resolveAdapter = options.getAdapter || getAdapter;
  const source = resolveAdapter(sourceId);
  const target = resolveAdapter(targetId);
  if (sourceId === targetId) throw new Error('源与目标是同一个工具');
  const notReady = target.writeReady();
  if (notReady) throw new Error(notReady);

  const { title, events, skipped } = source.readSession(cwd, sessionId);
  const stats = analyzeEvents(events, skipped);
  const provenance = {
    kind: 'marker' as const,
    ts: events[0]?.ts || new Date().toISOString(),
    text: `[agent-connect] 本会话由 ${source.label} 会话《${title}》迁移而来。以下为原始记录；工具调用已映射为目标工具的等价形式。请基于这些上下文继续工作。`,
  };
  const reportFile = options.reportFile || reportFilePath(cwd, sourceId, targetId, sessionId);
  const reportDirectory = path.dirname(reportFile);
  const report = renderReport({ source: source.label, target: target.label, title, stats, notes: target.writeNotes || [] });
  // Verify the sensitive central report location before creating a target-native session.
  fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(reportDirectory, 0o700);
  fs.accessSync(reportDirectory, fs.constants.W_OK);

  const written = target.writeSession(cwd, title, [provenance, ...events], { source: sourceId });
  const temporaryReport = `${reportFile}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryReport, report, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryReport, reportFile);
  } catch (error) {
    fs.rmSync(temporaryReport, { force: true });
    throw new Error(`目标会话已创建（${written.resumeHint}），但迁移报告写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return { title, stats, summary: summaryLine(stats), reportFile, targetId: written.id, resumeHint: written.resumeHint };
}
