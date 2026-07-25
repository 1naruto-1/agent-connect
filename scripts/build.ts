import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { assertSemVer } from '../src/semver.ts';

interface BuildTarget {
  name: string;
  bunTarget: string;
  extension: string;
}

const targets: BuildTarget[] = [
  { name: 'windows-x64', bunTarget: 'bun-windows-x64-baseline', extension: '.exe' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64-baseline', extension: '' },
  { name: 'linux-arm64', bunTarget: 'bun-linux-arm64', extension: '' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', extension: '' },
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', extension: '' },
];

function hostTarget(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  const target = `${os}-${arch}`;
  if (!targets.some((item) => item.name === target)) throw new Error(`Unsupported local build platform: ${process.platform}/${process.arch}`);
  return target;
}

function parseTargets(argv: string[]): BuildTarget[] {
  if (argv.includes('--all')) return targets;
  const index = argv.indexOf('--target');
  const selected = index >= 0 ? argv[index + 1] : hostTarget();
  if (!selected) throw new Error('Missing target after --target');
  const target = targets.find((item) => item.name === selected);
  if (!target) throw new Error(`Unknown target: ${selected}. Supported: ${targets.map((item) => item.name).join(', ')}`);
  return [target];
}

function assetName(version: string, target: BuildTarget): string {
  return `agent-connect-v${version}-${target.name}${target.extension}`;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const version = packageJson.version;
assertSemVer(version, 'package.json version');
const selected = parseTargets(process.argv.slice(2));
const outDir = path.resolve('dist');
fs.mkdirSync(outDir, { recursive: true });

for (const target of selected) {
  const output = path.join(outDir, assetName(version, target));
  const result = Bun.spawnSync({
    cmd: ['bun', 'build', 'src/cli.ts', '--compile', `--target=${target.bunTarget}`, `--outfile=${output}`, '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) throw new Error(`Build failed for ${target.name}`);
}

const files = fs.readdirSync(outDir)
  .filter((file) => file.startsWith(`agent-connect-v${version}-`))
  .sort();
if (files.length > 0) {
  const sums = files.map((file) => `${sha256(path.join(outDir, file))} *${file}`).join('\n');
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums}\n`, 'utf8');
}
