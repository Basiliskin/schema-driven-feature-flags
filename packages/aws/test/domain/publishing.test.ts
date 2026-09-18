import { describe, expect, it } from 'vitest';
import { parseCurrentPointer, snapshotKeyFor, type CurrentPointer } from '../../src/domain/current-pointer.js';
import {
  buildCurrentPointer,
  checkRollbackTarget,
  nextSnapshotVersion,
  validateEnvironmentName,
  validateVersion,
} from '../../src/domain/publishing.js';

const pointerAt = (version: number): CurrentPointer => buildCurrentPointer('production', version);

describe('nextSnapshotVersion', () => {
  it('starts at 1 when nothing has been published', () => {
    expect(nextSnapshotVersion(undefined)).toBe(1);
  });

  it('returns the current version plus one', () => {
    expect(nextSnapshotVersion(pointerAt(7))).toBe(8);
  });
});

describe('buildCurrentPointer', () => {
  it.each([1, 3, 42, 1000])('builds a pointer for version %i that the reader accepts', (version) => {
    const pointer = buildCurrentPointer('production', version);
    const parsed = parseCurrentPointer(JSON.parse(JSON.stringify(pointer)));

    expect(parsed).toEqual({ ok: true, value: pointer });
    expect(pointer.snapshotKey).toBe(snapshotKeyFor('production', version));
  });
});

describe('validateEnvironmentName', () => {
  it('accepts a plain environment name', () => {
    expect(validateEnvironmentName('staging')).toEqual({ ok: true, value: 'staging' });
  });

  it.each(['', 'prod/eu'])('rejects %j', (environment) => {
    const result = validateEnvironmentName(environment);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('INVALID_ENVIRONMENT');
  });
});

describe('validateVersion', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    [7, 7],
  ])('accepts %j', (input, expected) => {
    expect(validateVersion(input)).toEqual({ ok: true, value: expected });
  });

  it.each(['01', '1.0', '-1', '0', '', 'abc', 0, -1, 2.5, Number.NaN])('rejects %j', (input) => {
    const result = validateVersion(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('INVALID_VERSION');
  });
});

describe('checkRollbackTarget', () => {
  const reasonOf = (current: CurrentPointer | undefined, target: number) => {
    const result = checkRollbackTarget(current, target);
    if (result.ok) throw new Error('expected the rollback target to be rejected');
    expect(result.error.message).not.toBe('');
    return result.error.reason;
  };

  it('rejects a rollback when nothing has been published', () => {
    expect(reasonOf(undefined, 1)).toBe('NO_CURRENT_POINTER');
  });

  it.each([0, -1, 2.5, Number.NaN])('rejects target %j', (target) => {
    expect(reasonOf(pointerAt(5), target)).toBe('INVALID_VERSION');
  });

  it('rejects the current version as a target', () => {
    expect(reasonOf(pointerAt(5), 5)).toBe('TARGET_NOT_BELOW_CURRENT');
  });

  it('rejects a target above the current version', () => {
    expect(reasonOf(pointerAt(5), 6)).toBe('TARGET_NOT_BELOW_CURRENT');
  });

  it.each([1, 4])('accepts lower target %i', (target) => {
    expect(checkRollbackTarget(pointerAt(5), target)).toEqual({ ok: true, value: target });
  });
});
