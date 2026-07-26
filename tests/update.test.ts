import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { update } from '../src/commands/update.ts';
import { artifactName, hostBuildTarget } from '../src/release-targets.ts';
import { VERSION } from '../src/version.ts';

const NEWER_VERSION = '99.0.0';
const OLDER_VERSION = '0.0.1';

interface Fixture {
  directory: string;
  executable: string;
  requests: string[];
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setupFixture(options: { latest: string; assetBytes?: Uint8Array; badChecksum?: boolean } ): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-update-'));
  const executable = path.join(directory, process.platform === 'win32' ? 'agent-connect.exe' : 'agent-connect');
  fs.writeFileSync(executable, 'current binary\n', { mode: 0o755 });

  const requests: string[] = [];
  const assetBytes = options.assetBytes ?? new TextEncoder().encode('new binary\n');
  const hash = options.badChecksum ? '0'.repeat(64) : createHash('sha256').update(assetBytes).digest('hex');

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === '/releases/latest') {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${server.port}/releases/tag/v${options.latest}` },
        });
      }
      const download = /^\/releases\/download\/v([^/]+)\/(.+)$/.exec(url.pathname);
      if (download) {
        const [, version, file] = download;
        if (file === 'SHA256SUMS') return new Response(`${hash} *${artifactName(version!, hostBuildTarget())}\n`);
        if (file === artifactName(version!, hostBuildTarget())) return new Response(assetBytes);
      }
      return new Response('not found', { status: 404 });
    },
  });

  const savedEnv = {
    AGENT_CONNECT_RELEASE_BASE_URL: process.env.AGENT_CONNECT_RELEASE_BASE_URL,
    AGENT_CONNECT_UPDATE_TARGET: process.env.AGENT_CONNECT_UPDATE_TARGET,
  };
  process.env.AGENT_CONNECT_RELEASE_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.AGENT_CONNECT_UPDATE_TARGET = executable;
  cleanups.push(() => {
    server.stop(true);
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name as keyof typeof savedEnv];
      else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, executable, requests };
}

test('update installs a newer release, replaces the binary, and cleans stale backups', async () => {
  const fixture = setupFixture({ latest: NEWER_VERSION });
  const staleBackup = `${fixture.executable}.old-12345`;
  fs.writeFileSync(staleBackup, 'stale backup\n');

  await update([]);

  expect(fs.readFileSync(fixture.executable, 'utf8')).toBe('new binary\n');
  expect(fs.existsSync(staleBackup)).toBe(false);
  expect(fs.readdirSync(fixture.directory)).toEqual([path.basename(fixture.executable)]);
  expect(fixture.requests).toContain('/releases/latest');
  expect(fixture.requests).toContain(`/releases/download/v${NEWER_VERSION}/SHA256SUMS`);
});

test('update --check reports the newer release without touching the binary', async () => {
  const fixture = setupFixture({ latest: NEWER_VERSION });

  await update(['--check']);

  expect(fs.readFileSync(fixture.executable, 'utf8')).toBe('current binary\n');
  expect(fixture.requests).toEqual(['/releases/latest']);
});

test('update is a no-op when already on the latest release', async () => {
  const fixture = setupFixture({ latest: VERSION });

  await update([]);

  expect(fs.readFileSync(fixture.executable, 'utf8')).toBe('current binary\n');
  expect(fixture.requests).toEqual(['/releases/latest']);
});

test('update aborts on checksum mismatch and keeps the current binary', async () => {
  const fixture = setupFixture({ latest: NEWER_VERSION, badChecksum: true });

  await expect(update([])).rejects.toThrow('SHA-256 校验不通过');

  expect(fs.readFileSync(fixture.executable, 'utf8')).toBe('current binary\n');
  expect(fs.readdirSync(fixture.directory)).toEqual([path.basename(fixture.executable)]);
});

test('update installs an explicitly requested older release without resolving latest', async () => {
  const fixture = setupFixture({ latest: NEWER_VERSION });

  await update([`v${OLDER_VERSION}`]);

  expect(fs.readFileSync(fixture.executable, 'utf8')).toBe('new binary\n');
  expect(fixture.requests).not.toContain('/releases/latest');
  expect(fixture.requests).toContain(`/releases/download/v${OLDER_VERSION}/SHA256SUMS`);
});

test('update rejects unknown flags and invalid versions', async () => {
  const fixture = setupFixture({ latest: NEWER_VERSION });

  await expect(update(['--force'])).rejects.toThrow('未知选项');
  await expect(update(['not-a-version'])).rejects.toThrow('SemVer');
  expect(fs.readFileSync(fixture.executable, 'utf8')).toBe('current binary\n');
});
