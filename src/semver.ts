// SemVer 2.0.0: numeric core identifiers have no leading zeros; numeric prerelease identifiers do not either.
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function assertSemVer(value: string, source = 'version'): void {
  if (!isSemVer(value)) throw new Error(`${source} is not valid SemVer 2.0.0: ${value}`);
}
