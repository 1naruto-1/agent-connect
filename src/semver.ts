// SemVer 2.0.0: numeric core identifiers have no leading zeros; numeric prerelease identifiers do not either.
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function assertSemVer(value: string, source = 'version'): void {
  if (!isSemVer(value)) throw new Error(`${source} is not valid SemVer 2.0.0: ${value}`);
}

// SemVer 2.0.0 第 11 条优先级: 主.次.补丁数值比较; 有预发布号的低于没有的; 预发布段逐段比较, 数字段小于字母段
export function compareSemVer(left: string, right: string): number {
  assertSemVer(left, 'left version');
  assertSemVer(right, 'right version');
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const [, major, minor, patch, prerelease] = SEMVER_PATTERN.exec(value)!;
    return { core: [Number(major), Number(minor), Number(patch)], prerelease: prerelease ? prerelease.split('.') : [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! !== b.core[index]!) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Number(b.prerelease.length > 0) - Number(a.prerelease.length > 0);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const segmentA = a.prerelease[index];
    const segmentB = b.prerelease[index];
    if (segmentA === undefined) return -1;
    if (segmentB === undefined) return 1;
    if (segmentA === segmentB) continue;
    const numericA = /^\d+$/.test(segmentA);
    const numericB = /^\d+$/.test(segmentB);
    if (numericA && numericB) return Number(segmentA) < Number(segmentB) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return segmentA < segmentB ? -1 : 1;
  }
  return 0;
}
