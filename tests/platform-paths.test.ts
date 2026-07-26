import { describe, expect, test } from 'bun:test';
import { dataDirectory, executableDirectory, getAppPaths, normalizeProjectPath, projectKey, reportFilePath } from '../src/platform/paths.ts';

// SemVer 用例已移至 tests/semver.test.ts

describe('platform paths', () => {
  test('uses %APPDATA% and ~/.local/bin on Windows', () => {
    const options = { platform: 'win32' as const, homeDir: 'C:\\Users\\Ada', env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' } };
    expect(dataDirectory(options)).toBe('C:\\Users\\Ada\\AppData\\Roaming\\agent-connect');
    expect(executableDirectory(options)).toBe('C:\\Users\\Ada\\.local\\bin');
  });
  test('uses Application Support on macOS', () => {
    const options = { platform: 'darwin' as const, homeDir: '/Users/ada', env: {} };
    expect(dataDirectory(options)).toBe('/Users/ada/Library/Application Support/agent-connect');
  });
  test('uses XDG data location on Linux', () => {
    const options = { platform: 'linux' as const, homeDir: '/home/ada', env: { XDG_DATA_HOME: '/var/data' } };
    expect(getAppPaths(options).reportsDir).toBe('/var/data/agent-connect/reports');
  });
  test('honors explicit data and binary directory overrides', () => {
    const options = { platform: 'linux' as const, homeDir: '/home/ada', env: { AGENT_CONNECT_DATA_DIR: '/tmp/ac', AGENT_CONNECT_BIN_DIR: '/opt/ac/bin' } };
    expect(dataDirectory(options)).toBe('/tmp/ac');
    expect(executableDirectory(options)).toBe('/opt/ac/bin');
  });
  test('normalizes Windows project paths before hashing', () => {
    const options = { platform: 'win32' as const, homeDir: 'C:\\Users\\Ada', env: {} };
    expect(normalizeProjectPath('C:\\Work\\Project\\', options)).toBe('c:/work/project');
    expect(projectKey('C:\\Work\\Project', options)).toBe(projectKey('c:/work/project/', options));
  });
  test('uses a random suffix to prevent report collisions', () => {
    const options = { platform: 'linux' as const, homeDir: '/home/ada', env: {} };
    const now = new Date('2026-07-25T12:34:56.789Z');
    expect(reportFilePath('/work/project', 'cursor', 'pi', 'abc-123', now, options)).not.toBe(reportFilePath('/work/project', 'cursor', 'pi', 'abc-123', now, options));
  });

  test('stores reports outside project directories', () => {
    const options = { platform: 'linux' as const, homeDir: '/home/ada', env: {} };
    expect(reportFilePath('/work/project', 'cursor', 'pi', 'abc-123', new Date('2026-07-25T12:34:56.789Z'), options))
      .toMatch(/^\/home\/ada\/\.local\/share\/agent-connect\/reports\/[a-f0-9]{16}\/report-2026-07-25T12-34-56-789Z-cursor-to-pi-abc-123-[a-f0-9]{8}\.md$/);
  });
});
