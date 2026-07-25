import fs from 'node:fs';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { artifactName, hostBuildTarget } from './release-targets.ts';

function run(binary: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [binary, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${path.basename(binary)} ${args.join(' ')} exited ${result.exitCode}:\n${stderr || stdout}`);
  }
  return stdout;
}

if (process.argv.length !== 2) throw new Error('Usage: bun run smoke:build');
const binary = path.resolve('dist', artifactName(packageJson.version, hostBuildTarget()));
if (!fs.existsSync(binary)) throw new Error(`Host build does not exist: ${binary}`);

const version = run(binary, ['--version']).trim();
if (version !== packageJson.version) {
  throw new Error(`Standalone version mismatch: expected ${packageJson.version}, received ${version}`);
}
const help = run(binary, ['--help']);
if (!help.includes('agent-connect') || !help.includes('Cursor') || !help.includes('Claude Code')) {
  throw new Error('Standalone help output is missing expected CLI text.');
}

console.log(`Standalone smoke test passed: ${path.basename(binary)}`);
