import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/migrate.ts';
import type { Adapter, AdapterId } from '../src/types.ts';

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) fs.rmSync(temporaryPath, { recursive: true, force: true });
});

function sourceAdapter(): Adapter {
  return {
    id: 'pi', label: 'Pi', available: () => true, listSessions: () => [], writeReady: () => null,
    readSession: () => ({ title: 'fixture', events: [{ kind: 'user', ts: '2026-01-01T00:00:00.000Z', text: 'continue' }], skipped: {} }),
    writeSession: () => ({ id: 'source-id', resumeHint: 'resume source-id' }),
  };
}

test('writes a migration report outside the project through an injected adapter registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-test-'));
  temporaryPaths.push(root);
  const project = path.join(root, 'project');
  const reportFile = path.join(root, 'app-data', 'reports', 'project-key', 'report.md');
  fs.mkdirSync(project);
  const source = sourceAdapter();
  const target: Adapter = {
    ...source,
    id: 'claude', label: 'Claude Code',
    writeSession: () => ({ id: 'target-id', resumeHint: 'resume target-id' }),
    writeNotes: ['fixture note'],
  };
  const resolve = (id: AdapterId): Adapter => id === 'pi' ? source : target;

  const result = migrate(project, 'pi', 'source-id', 'claude', { getAdapter: resolve, reportFile });
  expect(result.reportFile).toBe(reportFile);
  expect(fs.existsSync(reportFile)).toBe(true);
  expect(fs.existsSync(path.join(project, '.agent-connect'))).toBe(false);
  expect(fs.readFileSync(reportFile, 'utf8')).toContain('fixture note');
});

test('checks the report directory before creating a target session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-test-'));
  temporaryPaths.push(root);
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'fixture');
  let wroteTarget = false;
  const source = sourceAdapter();
  const target: Adapter = {
    ...source,
    id: 'claude', label: 'Claude Code',
    writeSession: () => { wroteTarget = true; return { id: 'target', resumeHint: 'target' }; },
  };
  const resolve = (id: AdapterId): Adapter => id === 'pi' ? source : target;

  expect(() => migrate(path.join(root, 'project'), 'pi', 'source', 'claude', { getAdapter: resolve, reportFile: path.join(blocker, 'report.md') })).toThrow();
  expect(wroteTarget).toBe(false);
});
