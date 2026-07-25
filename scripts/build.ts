import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { assertSemVer } from '../src/semver.ts';
import { artifactName, BUILD_TARGETS, hostBuildTarget, type BuildTarget } from './release-targets.ts';

function parseTargets(argv: string[]): BuildTarget[] {
  if (argv.length === 0) return [hostBuildTarget()];
  if (argv.length === 1 && argv[0] === '--all') return [...BUILD_TARGETS];
  if (argv.length === 2 && argv[0] === '--target') {
    const target = BUILD_TARGETS.find((item) => item.name === argv[1]);
    if (target) return [target];
    throw new Error(`Unknown target: ${argv[1]}. Supported: ${BUILD_TARGETS.map((item) => item.name).join(', ')}`);
  }
  throw new Error('Usage: bun run build [-- --all | -- --target <platform-architecture>]');
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const version = packageJson.version;
assertSemVer(version, 'package.json version');
const selected = parseTargets(process.argv.slice(2));
const outDir = path.resolve('dist');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const files: string[] = [];
for (const target of selected) {
  const file = artifactName(version, target);
  const output = path.join(outDir, file);
  const result = Bun.spawnSync({
    cmd: ['bun', 'build', 'src/cli.ts', '--compile', `--target=${target.bunTarget}`, `--outfile=${output}`, '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'],
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: 300_000,
  });
  if (result.exitCode !== 0) throw new Error(`Build failed for ${target.name}`);
  files.push(file);
}

const sums = files.sort().map((file) => `${sha256(path.join(outDir, file))} *${file}`).join('\n');
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums}\n`, 'utf8');
