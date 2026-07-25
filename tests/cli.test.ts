import { expect, test } from 'bun:test';

function runCli(...args: string[]) {
  return Bun.spawnSync({ cmd: ['bun', 'run', 'src/cli.ts', ...args], stdout: 'pipe', stderr: 'pipe' });
}

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
