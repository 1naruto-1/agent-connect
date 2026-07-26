export interface BuildTarget {
  name: string;
  bunTarget: string;
  extension: string;
}

export const BUILD_TARGETS: readonly BuildTarget[] = [
  { name: 'windows-x64', bunTarget: 'bun-windows-x64-baseline', extension: '.exe' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64-baseline', extension: '' },
  { name: 'linux-arm64', bunTarget: 'bun-linux-arm64', extension: '' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', extension: '' },
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', extension: '' },
];

export function artifactName(version: string, target: BuildTarget): string {
  return `agent-connect-v${version}-${target.name}${target.extension}`;
}

export function hostBuildTarget(): BuildTarget {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const name = `${platform}-${process.arch}`;
  const target = BUILD_TARGETS.find((candidate) => candidate.name === name);
  if (!target) {
    throw new Error(
      `Unsupported architecture for local builds: ${process.platform}/${process.arch}. Supported targets: ${BUILD_TARGETS.map((candidate) => candidate.name).join(', ')}`,
    );
  }
  return target;
}
