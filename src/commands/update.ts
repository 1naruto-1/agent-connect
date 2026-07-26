import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { artifactName, hostBuildTarget } from '../release-targets.ts';
import { assertSemVer, compareSemVer } from '../semver.ts';
import { VERSION } from '../version.ts';

const DEFAULT_REPOSITORY = '1naruto-1/agent-connect';

function releaseBase(): string {
  const override = process.env.AGENT_CONNECT_RELEASE_BASE_URL;
  return (override || `https://github.com/${DEFAULT_REPOSITORY}`).replace(/\/+$/, '');
}

// 默认替换正在运行的二进制本体; AGENT_CONNECT_UPDATE_TARGET 供测试与非常规安装位置覆盖
function targetExecutable(): string {
  const override = process.env.AGENT_CONNECT_UPDATE_TARGET;
  if (override) return path.resolve(override);
  const compiled = Bun.main.includes('$bunfs') || Bun.main.includes('~BUN');
  if (!compiled) throw new Error('开发模式（bun run）不支持自更新，请通过 git 更新仓库。');
  return process.execPath;
}

// Bun 的 fetch 原生尊重 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量
async function fetchOrThrow(url: string, redirect: 'follow' | 'manual' = 'follow'): Promise<Response> {
  try {
    return await fetch(url, { redirect });
  } catch (error) {
    throw new Error(`网络请求失败：${url}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

async function resolveLatestVersion(): Promise<string> {
  const url = `${releaseBase()}/releases/latest`;
  const response = await fetchOrThrow(url, 'manual');
  const location = response.headers.get('location') ?? '';
  const match = /\/releases\/tag\/v([^/?#]+)$/.exec(location);
  if (!match) {
    throw new Error(`无法从 ${url} 解析最新版本（HTTP ${response.status}）。可用 agent-connect update <版本号> 指定版本。`);
  }
  const version = decodeURIComponent(match[1]!);
  assertSemVer(version, '最新发布版本');
  return version;
}

function expectedHash(checksums: string, assetName: string): string {
  for (const line of checksums.split('\n')) {
    const match = /^([A-Fa-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === assetName) return match[1]!.toLowerCase();
  }
  throw new Error(`SHA256SUMS 中没有 ${assetName} 的校验和。`);
}

// Windows 上仍在运行的旧二进制会留下 .old-<pid> 文件, 在下一次更新时尽力清理
function cleanupStaleBackups(executable: string): void {
  const directory = path.dirname(executable);
  const prefix = `${path.basename(executable)}.old-`;
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(directory, entry), { force: true });
    } catch {
      // 旧进程尚未退出时删除会失败, 留给下一次更新
    }
  }
}

async function installVersion(version: string, executable: string): Promise<void> {
  const assetName = artifactName(version, hostBuildTarget());
  const base = `${releaseBase()}/releases/download/v${version}`;

  const checksumResponse = await fetchOrThrow(`${base}/SHA256SUMS`);
  if (!checksumResponse.ok) throw new Error(`下载 SHA256SUMS 失败（HTTP ${checksumResponse.status}）：${base}/SHA256SUMS`);
  const expected = expectedHash(await checksumResponse.text(), assetName);

  const assetResponse = await fetchOrThrow(`${base}/${assetName}`);
  if (!assetResponse.ok) throw new Error(`下载 ${assetName} 失败（HTTP ${assetResponse.status}）。`);
  const bytes = new Uint8Array(await assetResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${assetName} 的 SHA-256 校验不通过，已放弃更新。`);

  const staging = path.join(path.dirname(executable), `.${path.basename(executable)}-${version}-${randomUUID().slice(0, 8)}`);
  fs.writeFileSync(staging, bytes, { mode: 0o755 });
  const backup = `${executable}.old-${process.pid}`;
  try {
    // 正在运行的 exe 不能被覆盖但可以改名, 与 install.ps1 的替换方式一致; POSIX 的 rename 本身即原子覆盖
    if (process.platform === 'win32' && fs.existsSync(executable)) fs.renameSync(executable, backup);
    fs.renameSync(staging, executable);
  } catch (error) {
    if (process.platform === 'win32' && fs.existsSync(backup) && !fs.existsSync(executable)) {
      try { fs.renameSync(backup, executable); } catch { }
    }
    fs.rmSync(staging, { force: true });
    throw error;
  }
  try { fs.rmSync(backup, { force: true }); } catch { }
}

export async function update(args: string[]): Promise<void> {
  const flags = new Set(args.filter((argument) => argument.startsWith('--')));
  const positional = args.filter((argument) => !argument.startsWith('--'));
  const checkOnly = flags.delete('--check');
  if (flags.size > 0) throw new Error(`未知选项：${[...flags].join('、')}`);
  if (positional.length > 1) throw new Error('最多指定一个目标版本。');

  const requested = positional[0]?.replace(/^v/, '');
  if (requested !== undefined) assertSemVer(requested, '目标版本');

  const target = requested ?? await resolveLatestVersion();
  const comparison = compareSemVer(target, VERSION);

  if (comparison === 0 || (requested === undefined && comparison < 0)) {
    console.log(`已是最新版本：v${VERSION}`);
    return;
  }
  if (checkOnly) {
    console.log(`发现可用版本：v${target}（当前 v${VERSION}）。运行 agent-connect update${requested === undefined ? '' : ` ${target}`} 安装。`);
    return;
  }
  const executable = targetExecutable();
  cleanupStaleBackups(executable);
  console.log(comparison < 0 ? `正在从 v${VERSION} 降级到 v${target}…` : `正在从 v${VERSION} 更新到 v${target}…`);
  await installVersion(target, executable);
  console.log(`已更新到 v${target}：${executable}`);
}
