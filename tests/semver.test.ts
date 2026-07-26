import { describe, expect, test } from 'bun:test';
import { assertSemVer, isSemVer } from '../src/semver.ts';
import { VERSION } from '../src/version.ts';

describe('isSemVer', () => {
  test('package version uses SemVer 2.0.0', () => {
    expect(isSemVer(VERSION)).toBe(true);
  });

  test('accepts valid SemVer 2.0.0 versions', () => {
    expect(isSemVer('0.0.0')).toBe(true);
    expect(isSemVer('1.2.3')).toBe(true);
    expect(isSemVer('10.20.30')).toBe(true);
    expect(isSemVer('1.2.3-alpha.1')).toBe(true);
    expect(isSemVer('1.2.3-0.3.7')).toBe(true);
    expect(isSemVer('1.2.3+build.5')).toBe(true);
    expect(isSemVer('1.2.3-rc.1+meta.001')).toBe(true);
  });

  test('rejects invalid versions', () => {
    expect(isSemVer('1.2')).toBe(false);
    expect(isSemVer('v1.2.3')).toBe(false);
    expect(isSemVer('01.2.3')).toBe(false); // 主版本前导零
    expect(isSemVer('1.2.3-01')).toBe(false); // 数字预发布段前导零
    expect(isSemVer('1.2.3-a..b')).toBe(false); // 空预发布段
    expect(isSemVer('1.2.3+')).toBe(false);
    expect(isSemVer('1.2.3 ')).toBe(false);
    expect(isSemVer('')).toBe(false);
  });
});

describe('assertSemVer', () => {
  test('does not throw for valid versions', () => {
    expect(() => assertSemVer('1.2.3')).not.toThrow();
    expect(() => assertSemVer('1.2.3-alpha+build')).not.toThrow();
    expect(() => assertSemVer(VERSION)).not.toThrow();
  });

  test('throws with the source label for invalid versions', () => {
    expect(() => assertSemVer('not-a-version')).toThrow('version is not valid SemVer 2.0.0: not-a-version');
    expect(() => assertSemVer('01.2.3', 'package.json version')).toThrow('package.json version is not valid SemVer 2.0.0: 01.2.3');
  });
});
