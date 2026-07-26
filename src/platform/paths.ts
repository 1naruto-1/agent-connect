import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface PathOptions { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; homeDir?: string; }
export interface AppPaths { dataDir: string; reportsDir: string; executableDir: string; }

const platformOf = (options: PathOptions): NodeJS.Platform => options.platform ?? process.platform;
const envOf = (options: PathOptions): NodeJS.ProcessEnv => options.env ?? process.env;
const pathFor = (platformName: NodeJS.Platform): typeof path => platformName === 'win32' ? path.win32 : path.posix;
const homeOf = (options: PathOptions): string => options.homeDir ?? os.homedir();

// 会话存储的家目录: 优先环境变量 (win32 读 USERPROFILE, 其余读 HOME), 与 cursor.ts 的解析一致
// Bun 在 POSIX 上的 os.homedir() 不读 HOME, 环境变量优先也让测试可以注入临时家目录
export function homeDirectory(): string {
  return (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
}

export function dataDirectory(options: PathOptions = {}): string {
  const platformName = platformOf(options);
  const env = envOf(options);
  const paths = pathFor(platformName);
  if (env.AGENT_CONNECT_DATA_DIR) return paths.resolve(env.AGENT_CONNECT_DATA_DIR);
  const home = homeOf(options);
  if (platformName === 'win32') return paths.join(env.APPDATA || paths.join(home, 'AppData', 'Roaming'), 'agent-connect');
  if (platformName === 'darwin') return paths.join(home, 'Library', 'Application Support', 'agent-connect');
  return paths.join(env.XDG_DATA_HOME || paths.join(home, '.local', 'share'), 'agent-connect');
}

export function executableDirectory(options: PathOptions = {}): string {
  const paths = pathFor(platformOf(options));
  const override = envOf(options).AGENT_CONNECT_BIN_DIR;
  return override ? paths.resolve(override) : paths.join(homeOf(options), '.local', 'bin');
}

export function getAppPaths(options: PathOptions = {}): AppPaths {
  const paths = pathFor(platformOf(options));
  const dataDir = dataDirectory(options);
  return { dataDir, reportsDir: paths.join(dataDir, 'reports'), executableDir: executableDirectory(options) };
}

export function normalizeProjectPath(cwd: string, options: PathOptions = {}): string {
  const platformName = platformOf(options);
  const paths = pathFor(platformName);
  const resolved = paths.resolve(cwd).replaceAll('\\', '/');
  const normalized = resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
  return platformName === 'win32' ? normalized.toLowerCase() : normalized;
}

export function projectKey(cwd: string, options: PathOptions = {}): string {
  return createHash('sha256').update(normalizeProjectPath(cwd, options)).digest('hex').slice(0, 16);
}

export function reportFilePath(cwd: string, source: string, target: string, sessionId: string, now = new Date(), options: PathOptions = {}, nonce = randomUUID().slice(0, 8)): string {
  const paths = pathFor(platformOf(options));
  const timestamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'session';
  return paths.join(getAppPaths(options).reportsDir, projectKey(cwd, options), `report-${timestamp}-${source}-to-${target}-${safeId}-${nonce}.md`);
}
