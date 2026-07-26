import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

const FIXTURE_VERSION = packageJson.version;
const FIXTURE_TAG = `v${FIXTURE_VERSION}`;

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) fs.rmSync(temporaryPath, { recursive: true, force: true });
});

function output(result: ReturnType<typeof Bun.spawnSync>): string {
  return `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`;
}

if (process.platform === 'linux' || process.platform === 'darwin') {
  test('Unix installer resolves latest, verifies SHA-256, and installs offline', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-installer-'));
    temporaryPaths.push(root);
    const fakeBin = path.join(root, 'fake-bin');
    const home = path.join(root, 'home');
    const installDirectory = path.join(home, "bin 'single\"double\\slash dollar$'");
    const asset = path.join(root, 'asset');
    const checksums = path.join(root, 'SHA256SUMS');
    const requestLog = path.join(root, 'requests.log');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(asset, '#!/bin/sh\nprintf \'fixture binary\\n\'\n', { mode: 0o755 });

    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const unamePlatform = process.platform === 'darwin' ? 'Darwin' : 'Linux';
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
    const unameArchitecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const assetName = `agent-connect-v${FIXTURE_VERSION}-${platform}-${architecture}`;
    const hash = createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
    fs.writeFileSync(checksums, `${hash} *${assetName}\n`);

    const curl = `#!/bin/sh
set -eu
url=''
out=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|-w|--proto|--retry) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$FIXTURE_LOG"
case "$url" in
  */releases/latest)
    printf 'https://github.com/fixture/repository/releases/tag/${FIXTURE_TAG}'
    exit 0
    ;;
esac
if [ -n "$out" ]; then
  case "$url" in
    *SHA256SUMS) cp "$FIXTURE_SUMS" "$out" ;;
    *) cp "$FIXTURE_ASSET" "$out" ;;
  esac
else
  printf '{"tag_name":"${FIXTURE_TAG}"}\\n'
fi
`;
    const uname = `#!/bin/sh
case "$1" in
  -s) printf '${unamePlatform}\\n' ;;
  -m) printf '${unameArchitecture}\\n' ;;
  *) exit 2 ;;
esac
`;
    const curlPath = path.join(fakeBin, 'curl');
    const unamePath = path.join(fakeBin, 'uname');
    fs.writeFileSync(curlPath, curl, { mode: 0o755 });
    fs.writeFileSync(unamePath, uname, { mode: 0o755 });

    const syntax = Bun.spawnSync({ cmd: ['sh', '-n', 'scripts/install.sh'], stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(syntax.exitCode, output(syntax)).toBe(0);

    const env = {
      ...process.env,
      HOME: home,
      SHELL: '/bin/sh',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      AGENT_CONNECT_VERSION: 'latest',
      AGENT_CONNECT_REPOSITORY: 'fixture/repository',
      AGENT_CONNECT_BIN_DIR: installDirectory,
      FIXTURE_ASSET: asset,
      FIXTURE_SUMS: checksums,
      FIXTURE_LOG: requestLog,
    };
    const first = Bun.spawnSync({ cmd: ['sh', 'scripts/install.sh'], env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(first.exitCode, output(first)).toBe(0);
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect'))).toEqual(fs.readFileSync(asset));

    const requests = fs.readFileSync(requestLog, 'utf8');
    expect(requests).toContain('https://github.com/fixture/repository/releases/latest');
    expect(requests).not.toContain('https://api.github.com/');
    expect(requests).toContain(`https://github.com/fixture/repository/releases/download/${FIXTURE_TAG}/${assetName}`);
    expect(requests).toContain(`https://github.com/fixture/repository/releases/download/${FIXTURE_TAG}/SHA256SUMS`);

    const updatedAsset = path.join(root, 'updated-asset');
    const updatedChecksums = path.join(root, 'updated-SHA256SUMS');
    fs.writeFileSync(updatedAsset, '#!/bin/sh\nprintf \'updated fixture binary\\n\'\n', { mode: 0o755 });
    const updatedHash = createHash('sha256').update(fs.readFileSync(updatedAsset)).digest('hex');
    fs.writeFileSync(updatedChecksums, `${updatedHash} *${assetName}\n`);
    const second = Bun.spawnSync({
      cmd: ['sh', 'scripts/install.sh'],
      env: { ...env, FIXTURE_ASSET: updatedAsset, FIXTURE_SUMS: updatedChecksums },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(second.exitCode, output(second)).toBe(0);
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect'))).toEqual(fs.readFileSync(updatedAsset));
    expect(fs.readdirSync(installDirectory).filter((file) => file.startsWith('.agent-connect-'))).toEqual([]);
    const profile = fs.readFileSync(path.join(home, '.profile'), 'utf8');
    expect(profile.match(/Added by Agent Connect installer/g)?.length).toBe(1);
    const pathCheck = Bun.spawnSync({
      cmd: ['sh', '-c', '. "$HOME/.profile"; command -v agent-connect'],
      env: { ...process.env, HOME: home, PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(pathCheck.exitCode, output(pathCheck)).toBe(0);

    const badAsset = path.join(root, 'bad-asset');
    const badChecksums = path.join(root, 'bad-SHA256SUMS');
    fs.writeFileSync(badAsset, 'tampered binary\n');
    fs.writeFileSync(badChecksums, `${'0'.repeat(64)} *${assetName}\n`);
    const mismatch = Bun.spawnSync({
      cmd: ['sh', 'scripts/install.sh'],
      env: { ...env, FIXTURE_ASSET: badAsset, FIXTURE_SUMS: badChecksums },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(mismatch.exitCode).not.toBe(0);
    expect(output(mismatch)).toContain('Checksum mismatch');
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect'))).toEqual(fs.readFileSync(updatedAsset));
    expect(fs.readdirSync(installDirectory).filter((file) => file.startsWith('.agent-connect-'))).toEqual([]);

    const missingChecksums = path.join(root, 'missing-SHA256SUMS');
    fs.writeFileSync(missingChecksums, `${updatedHash} *agent-connect-v${FIXTURE_VERSION}-other-target\n`);
    const missingEntry = Bun.spawnSync({
      cmd: ['sh', 'scripts/install.sh'],
      env: { ...env, FIXTURE_ASSET: updatedAsset, FIXTURE_SUMS: missingChecksums },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(missingEntry.exitCode).not.toBe(0);
    expect(output(missingEntry)).toContain(`SHA256SUMS does not contain ${assetName}`);
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect'))).toEqual(fs.readFileSync(updatedAsset));
    expect(fs.readdirSync(installDirectory).filter((file) => file.startsWith('.agent-connect-'))).toEqual([]);

    const invalid = Bun.spawnSync({
      cmd: ['sh', 'scripts/install.sh'],
      env: { ...env, AGENT_CONNECT_VERSION: '1.2.3-01' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(output(invalid)).toContain('Invalid or unavailable SemVer release');
  }, { timeout: 120_000 });
}

if (process.platform === 'win32') {
  test('PowerShell installer resolves latest, verifies SHA-256, and installs offline', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-installer-'));
    temporaryPaths.push(root);
    const home = path.join(root, 'home');
    const installDirectory = path.join(root, 'bin');
    const asset = path.join(root, 'asset.exe');
    const checksums = path.join(root, 'SHA256SUMS');
    const requestLog = path.join(root, 'requests.log');
    const script = path.resolve('scripts/install.ps1');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(asset, 'fixture executable\n');
    const assetName = `agent-connect-${FIXTURE_TAG}-windows-x64.exe`;
    const hash = createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
    fs.writeFileSync(checksums, `${hash} *${assetName}\n`);

    const env = {
      ...process.env,
      FIXTURE_HOME: home,
      FIXTURE_BIN: installDirectory,
      FIXTURE_ASSET: asset,
      FIXTURE_SUMS: checksums,
      FIXTURE_LOG: requestLog,
      FIXTURE_SCRIPT: script,
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '',
    };
    const command = `
$ErrorActionPreference = 'Stop'
[void][ScriptBlock]::Create((Get-Content -Raw -LiteralPath $env:FIXTURE_SCRIPT))
$env:USERPROFILE = $env:FIXTURE_HOME
$env:AGENT_CONNECT_BIN_DIR = $env:FIXTURE_BIN
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri, [hashtable]$Headers, [string]$Proxy, [pscredential]$ProxyCredential)
  throw 'Unexpected GitHub API request'
}
function Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$MaximumRedirection, [hashtable]$Headers, [string]$Proxy, [pscredential]$ProxyCredential)
  [IO.File]::AppendAllText($env:FIXTURE_LOG, $Uri + ' proxy=' + $Proxy + [Environment]::NewLine)
  if ($PSBoundParameters.ContainsKey('MaximumRedirection')) {
    return [pscustomobject]@{ StatusCode = 302; Headers = @{ Location = 'https://github.com/fixture/repository/releases/tag/${FIXTURE_TAG}' } }
  }
  if ($Uri -match 'SHA256SUMS$') {
    Copy-Item -LiteralPath $env:FIXTURE_SUMS -Destination $OutFile
  } else {
    Copy-Item -LiteralPath $env:FIXTURE_ASSET -Destination $OutFile
  }
}
& $env:FIXTURE_SCRIPT -Repository 'fixture/repository' -SkipPathUpdate
`;
    const result = Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(result.exitCode, output(result)).toBe(0);
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect.exe'))).toEqual(fs.readFileSync(asset));

    const requests = fs.readFileSync(requestLog, 'utf8');
    expect(requests).toContain('https://github.com/fixture/repository/releases/latest');
    expect(requests).not.toContain('https://api.github.com/');
    expect(requests).toContain(`https://github.com/fixture/repository/releases/download/${FIXTURE_TAG}/SHA256SUMS`);
    expect(requests).toContain(`https://github.com/fixture/repository/releases/download/${FIXTURE_TAG}/${assetName}`);

    const updatedAsset = path.join(root, 'updated-asset.exe');
    const updatedChecksums = path.join(root, 'updated-SHA256SUMS');
    fs.writeFileSync(updatedAsset, 'updated fixture executable\n');
    const updatedHash = createHash('sha256').update(fs.readFileSync(updatedAsset)).digest('hex');
    fs.writeFileSync(updatedChecksums, `${updatedHash} *${assetName}\n`);
    const replacement = Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      env: { ...env, FIXTURE_ASSET: updatedAsset, FIXTURE_SUMS: updatedChecksums, HTTPS_PROXY: 'http://127.0.0.1:9099' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(replacement.exitCode, output(replacement)).toBe(0);
    expect(fs.readFileSync(requestLog, 'utf8')).toContain('proxy=http://127.0.0.1:9099');
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect.exe'))).toEqual(fs.readFileSync(updatedAsset));
    expect(fs.readdirSync(installDirectory).filter((file) => file.startsWith('.agent-connect-'))).toEqual([]);
    expect(fs.readdirSync(installDirectory).filter((file) => file.includes('.old-'))).toEqual([]);

    const badAsset = path.join(root, 'bad-asset.exe');
    const badChecksums = path.join(root, 'bad-SHA256SUMS');
    fs.writeFileSync(badAsset, 'tampered executable\n');
    fs.writeFileSync(badChecksums, `${'0'.repeat(64)} *${assetName}\n`);
    const mismatch = Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      env: { ...env, FIXTURE_ASSET: badAsset, FIXTURE_SUMS: badChecksums },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(mismatch.exitCode).not.toBe(0);
    expect(output(mismatch)).toContain('Checksum mismatch');
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect.exe'))).toEqual(fs.readFileSync(updatedAsset));
    expect(fs.readdirSync(installDirectory).filter((file) => file.startsWith('.agent-connect-'))).toEqual([]);

    const missingChecksums = path.join(root, 'missing-SHA256SUMS');
    fs.writeFileSync(missingChecksums, `${updatedHash} *agent-connect-${FIXTURE_TAG}-other-target.exe\n`);
    const missingEntry = Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      env: { ...env, FIXTURE_ASSET: updatedAsset, FIXTURE_SUMS: missingChecksums },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(missingEntry.exitCode).not.toBe(0);
    expect(output(missingEntry)).toContain(`SHA256SUMS does not contain ${assetName}`);
    expect(fs.readFileSync(path.join(installDirectory, 'agent-connect.exe'))).toEqual(fs.readFileSync(updatedAsset));
    expect(fs.readdirSync(installDirectory).filter((file) => file.startsWith('.agent-connect-'))).toEqual([]);

    const invalidCommand = `
$env:USERPROFILE = $env:FIXTURE_HOME
$env:AGENT_CONNECT_BIN_DIR = $env:FIXTURE_BIN
function Invoke-RestMethod { throw 'Unexpected network request' }
function Invoke-WebRequest { throw 'Unexpected network request' }
& $env:FIXTURE_SCRIPT -Version '1.2.3-01' -Repository 'fixture/repository' -SkipPathUpdate
`;
    const invalid = Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', invalidCommand],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(output(invalid)).toContain('Invalid SemVer release');

    const rateLimitedCommand = `
$env:USERPROFILE = $env:FIXTURE_HOME
$env:AGENT_CONNECT_BIN_DIR = $env:FIXTURE_BIN
function Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$MaximumRedirection, [hashtable]$Headers, [string]$Proxy, [pscredential]$ProxyCredential)
  return $null
}
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri, [hashtable]$Headers, [string]$Proxy, [pscredential]$ProxyCredential)
  throw "API rate limit exceeded for 172.237.78.51. (But here's the good news: Authenticated requests get a higher rate limit.)"
}
& $env:FIXTURE_SCRIPT -Repository 'fixture/repository' -SkipPathUpdate
`;
    const rateLimited = Bun.spawnSync({
      cmd: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', rateLimitedCommand],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(rateLimited.exitCode).not.toBe(0);
    expect(output(rateLimited)).toContain('Could not resolve the latest release');
    expect(output(rateLimited)).toContain('Set GITHUB_TOKEN for a higher limit');
  }, { timeout: 120_000 });
}
