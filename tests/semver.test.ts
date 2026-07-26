import { describe, expect, test } from 'bun:test';
import { assertSemVer, compareSemVer, isSemVer } from '../src/semver.ts';
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

describe('compareSemVer', () => {
  test('orders by major, minor, and patch', () => {
    expect(compareSemVer('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemVer('2.1.0', '2.0.9')).toBe(1);
    expect(compareSemVer('0.2.4', '0.2.10')).toBe(-1);
    expect(compareSemVer('1.2.3', '1.2.3')).toBe(0);
  });

  test('ranks prereleases below releases and compares segments per SemVer 11', () => {
    expect(compareSemVer('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemVer('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemVer('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareSemVer('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1); // 数字段低于字母段
    expect(compareSemVer('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1); // 数字段按数值比较
    expect(compareSemVer('1.0.0-beta', '1.0.0-alpha')).toBe(1);
  });

  test('ignores build metadata', () => {
    expect(compareSemVer('1.2.3+build.1', '1.2.3+build.2')).toBe(0);
  });

  test('rejects invalid input', () => {
    expect(() => compareSemVer('1.2', '1.2.3')).toThrow('SemVer');
    expect(() => compareSemVer('1.2.3', 'nope')).toThrow('SemVer');
  });
});
