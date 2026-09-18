import { describe, expect, it } from 'vitest';
import { parseCurrentPointer, snapshotKeyFor } from '../../src/domain/current-pointer.js';

const validPointer = () => ({
  schemaVersion: 1,
  environment: 'production',
  version: 43,
  snapshotKey: 'production/snapshots/43.json',
});

const issuesOf = (raw: unknown) => {
  const result = parseCurrentPointer(raw);
  if (result.ok) throw new Error('expected the pointer to be rejected');
  expect(result.error.reason).toBe('INVALID_POINTER');
  return result.error.issues;
};

describe('snapshotKeyFor', () => {
  it('builds the snapshot key from environment and version', () => {
    expect(snapshotKeyFor('prod', 7)).toBe('prod/snapshots/7.json');
  });
});

describe('parseCurrentPointer', () => {
  it('accepts a valid pointer', () => {
    expect(parseCurrentPointer(validPointer())).toEqual({ ok: true, value: validPointer() });
  });

  it('ignores unknown extra fields', () => {
    expect(parseCurrentPointer({ ...validPointer(), publishedBy: 'ci' })).toEqual({ ok: true, value: validPointer() });
  });

  it.each(['schemaVersion', 'environment', 'version', 'snapshotKey'])('rejects a pointer missing %s', (field) => {
    const pointer = Object.fromEntries(Object.entries(validPointer()).filter(([key]) => key !== field));

    expect(issuesOf(pointer).map((issue) => issue.path)).toContain(field);
  });

  it.each([0, -1, 1.5, '3'])('rejects version %j', (version) => {
    expect(issuesOf({ ...validPointer(), version }).map((issue) => issue.path)).toContain('version');
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(issuesOf({ ...validPointer(), schemaVersion: 2 })[0]?.path).toBe('schemaVersion');
  });

  it.each(['', 'prod/eu'])('rejects environment %j', (environment) => {
    expect(issuesOf({ ...validPointer(), environment }).map((issue) => issue.path)).toContain('environment');
  });

  it.each(['production/snapshots/42.json', 'other-env/snapshots/43.json', 'production/snapshots/../../x/43.json'])(
    'rejects snapshotKey %j that does not match environment and version',
    (snapshotKey) => {
      expect(issuesOf({ ...validPointer(), snapshotKey })).toEqual([
        { path: 'snapshotKey', message: 'snapshotKey must equal <environment>/snapshots/<version>.json' },
      ]);
    },
  );

  it.each([null, [], 'production/snapshots/43.json', 43])('rejects non-object input %j without throwing', (raw) => {
    expect(issuesOf(raw)).toEqual([{ path: '', message: expect.any(String) as string }]);
  });
});
