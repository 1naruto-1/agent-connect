import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve(import.meta.dir, '..', 'src', 'cli.ts');

function runCli(...args: string[]) {
  return Bun.spawnSync({ cmd: ['bun', 'run', CLI, ...args], stdout: 'pipe', stderr: 'pipe' });
}

const temporaryPaths: string[] = [];
afterAll(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) fs.rmSync(temporaryPath, { recursive: true, force: true });
});

test('CLI exposes semantic version and paths', () => {
  const version = runCli('--version');
  expect(version.exitCode).toBe(0);
  expect(new TextDecoder().decode(version.stdout).trim()).toMatch(/^\d+\.\d+\.\d+/);

  const paths = runCli('paths');
  expect(paths.exitCode).toBe(0);
  expect(new TextDecoder().decode(paths.stdout)).toContain('应用数据目录');
});

test('CLI help documents centralized reports', () => {
  const help = runCli('--help');
  expect(help.exitCode).toBe(0);
  const output = new TextDecoder().decode(help.stdout);
  expect(output).toContain('不会在项目中创建 .agent-connect');
});

test('unknown command exits with code 1 and prints usage', () => {
  const result = runCli('definitely-not-a-command');
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stdout)).toContain('用法');
});

test('list --json returns a valid JSON array without file fields', () => {
  // 隔离的 HOME/APPDATA + 项目目录, 不读机器上的真实会话
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-cli-'));
  temporaryPaths.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });

  // 在隔离 home 里放一个 pi 会话 (pi 的 listSessions 会带 file 字段, list --json 应剥离)
  const encoded = `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = path.join(root, '.pi', 'agent', 'sessions', encoded);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionId = randomUUID();
  fs.writeFileSync(path.join(sessionDir, `2026-07-26T10-00-00-000Z_${sessionId}.jsonl`), [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-07-26T10:00:00.000Z', cwd: project }),
    JSON.stringify({ type: 'session_info', name: 'cli fixture', id: 'e1', parentId: null, timestamp: '2026-07-26T10:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-07-26T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
  ].join('\n') + '\n');

  const result = Bun.spawnSync({
    cmd: ['bun', 'run', CLI, 'list', '--json'],
    cwd: project,
    env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData', 'Roaming') },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  const sessions = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions.length).toBe(1);
  expect(sessions[0].source).toBe('pi');
  expect(sessions[0].title).toBe('cli fixture');
  for (const session of sessions) expect('file' in session).toBe(false);
}, 20000);
