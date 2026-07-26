import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { artifactName, BUILD_TARGETS } from '../src/release-targets.ts';

interface ChecksumEntry {
  hash: string;
  file: string;
}

function parseManifest(contents: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  const seen = new Set<string>();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line) continue;
    const match = /^([A-Fa-f0-9]{64}) \*([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line ${index + 1}: ${line}`);
    const hash = match[1];
    const file = match[2];
    if (!hash || !file) throw new Error(`Incomplete SHA256SUMS line ${index + 1}.`);
    if (seen.has(file)) throw new Error(`Duplicate SHA256SUMS entry: ${file}`);
    seen.add(file);
    entries.push({ hash: hash.toLowerCase(), file });
  }
  if (entries.length === 0) throw new Error('SHA256SUMS contains no artifacts.');
  return entries;
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--all') || args.filter((arg) => arg === '--all').length > 1) {
  throw new Error('Usage: bun run verify:checksums [-- --all]');
}
const requireAll = args.includes('--all');
const distDirectory = path.resolve('dist');
const manifestPath = path.join(distDirectory, 'SHA256SUMS');
if (!fs.existsSync(manifestPath)) throw new Error(`Checksum manifest does not exist: ${manifestPath}`);
const entries = parseManifest(fs.readFileSync(manifestPath, 'utf8'));

if (requireAll) {
  const expected = BUILD_TARGETS.map((target) => artifactName(packageJson.version, target)).sort();
  const actual = entries.map((entry) => entry.file).sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error(`Complete release manifest mismatch.\nExpected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`);
  }
}

const expectedDirectoryFiles = ['SHA256SUMS', ...entries.map((entry) => entry.file)].sort();
const actualDirectoryFiles = fs.readdirSync(distDirectory).sort();
if (actualDirectoryFiles.length !== expectedDirectoryFiles.length || actualDirectoryFiles.some((file, index) => file !== expectedDirectoryFiles[index])) {
  throw new Error(`Unexpected dist contents.\nExpected: ${expectedDirectoryFiles.join(', ')}\nActual: ${actualDirectoryFiles.join(', ')}`);
}

for (const entry of entries) {
  const artifactPath = path.join(distDirectory, entry.file);
  const actual = createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
  if (actual !== entry.hash) throw new Error(`Checksum mismatch: ${entry.file}`);
  console.log(`${entry.file}: OK`);
}
