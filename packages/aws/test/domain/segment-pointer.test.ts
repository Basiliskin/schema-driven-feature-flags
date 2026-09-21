import { describe, expect, it } from 'vitest';
import {
  buildSegmentPointer,
  nextSegmentVersion,
  parseSegmentPointer,
  segmentObjectKeyFor,
  segmentPointerKeyFor,
  validateSegmentKey,
} from '../../src/domain/segment-pointer.js';

const validPointer = () => ({
  schemaVersion: 1,
  environment: 'production',
  segmentKey: 'beta-testers',
  version: 2,
  objectKey: 'production/segments/beta-testers/2.json',
});

const issuesOf = (raw: unknown) => {
  const result = parseSegmentPointer(raw);
  if (result.ok) throw new Error('expected the pointer to be rejected');
  expect(result.error.reason).toBe('INVALID_POINTER');
  return result.error.issues;
};

describe('segment keys in S3', () => {
  it('builds the segment version key', () => {
    expect(segmentObjectKeyFor('prod', 'beta', 7)).toBe('prod/segments/beta/7.json');
  });

  it('builds the segment pointer key', () => {
    expect(segmentPointerKeyFor('prod', 'beta')).toBe('prod/segments/beta/current.json');
  });
});

describe('parseSegmentPointer', () => {
  it('accepts the pointer from the spec', () => {
    expect(parseSegmentPointer(validPointer())).toEqual({ ok: true, value: validPointer() });
  });

  it('ignores unknown extra fields and freezes the result', () => {
    const result = parseSegmentPointer({ ...validPointer(), uploadedBy: 'ci' });

    expect(result).toEqual({ ok: true, value: validPointer() });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    ['another version', 'production/segments/beta-testers/3.json'],
    ['another segment', 'production/segments/other/2.json'],
    ['another environment', 'staging/segments/beta-testers/2.json'],
    ['a snapshot key', 'production/snapshots/2.json'],
  ])('rejects an objectKey naming %s', (_label, objectKey) => {
    expect(issuesOf({ ...validPointer(), objectKey })).toEqual([
      { path: 'objectKey', message: 'objectKey must equal <environment>/segments/<segmentKey>/<version>.json' },
    ]);
  });

  it.each([
    ['schemaVersion', 2],
    ['environment', 'prod/eu'],
    ['segmentKey', '-starts-with-dash'],
    ['segmentKey', 'a'.repeat(65)],
    ['version', 0],
    ['version', -1],
    ['version', 1.5],
    ['objectKey', 42],
  ])('rejects an invalid %s (%j)', (field, value) => {
    expect(issuesOf({ ...validPointer(), [field]: value }).map((issue) => issue.path)).toContain(field);
  });

  it.each([null, 'current', []])('rejects a non-object %j', (raw) => {
    expect(issuesOf(raw).length).toBeGreaterThan(0);
  });
});

describe('nextSegmentVersion', () => {
  it('starts at 1 when the segment has no pointer', () => {
    expect(nextSegmentVersion(undefined)).toBe(1);
  });

  it('returns the current version plus one', () => {
    const pointer = parseSegmentPointer({ ...validPointer(), version: 4, objectKey: 'production/segments/beta-testers/4.json' });
    if (!pointer.ok) throw new Error('expected a valid pointer');

    expect(nextSegmentVersion(pointer.value)).toBe(5);
  });
});

describe('buildSegmentPointer', () => {
  it.each([1, 3, 42, 1000])('builds a pointer for version %i that the reader accepts', (version) => {
    const built = buildSegmentPointer('production', 'beta-testers', version, 'userId');
    if (!built.ok) throw new Error('expected a pointer');
    const pointer = built.value;
    const parsed = parseSegmentPointer(JSON.parse(JSON.stringify(pointer)));

    expect(parsed).toEqual({ ok: true, value: pointer });
    expect(pointer.objectKey).toBe(segmentObjectKeyFor('production', 'beta-testers', version));
    expect(Object.isFrozen(pointer)).toBe(true);
  });
});

describe('the member attribute on a segment pointer', () => {
  it('round-trips the attribute the segment was built with', () => {
    const built = buildSegmentPointer('production', 'beta-testers', 2, 'accountId');
    if (!built.ok) throw new Error('expected a pointer');

    expect(built.value.memberAttribute).toBe('accountId');
    expect(parseSegmentPointer(JSON.parse(JSON.stringify(built.value)))).toEqual({ ok: true, value: built.value });
  });

  it('parses a pointer published before the attribute was recorded', () => {
    const result = parseSegmentPointer(validPointer());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.memberAttribute).toBeUndefined();
  });

  it('rejects an empty attribute rather than storing one nothing can match on', () => {
    expect(issuesOf({ ...validPointer(), memberAttribute: '' })).toContainEqual(
      expect.objectContaining({ path: 'memberAttribute' }),
    );
  });
});

describe('buildSegmentPointer rejections', () => {
  it.each(['../x', 'A B', '../prod/current', ''])('rejects segment key %j with INVALID_SEGMENT_KEY', (key) => {
    const result = buildSegmentPointer('production', key, 1, 'userId');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('INVALID_SEGMENT_KEY');
  });

  it.each(['', 'prod/eu', '../x'])('rejects environment %j with INVALID_ENVIRONMENT', (environment) => {
    const result = buildSegmentPointer(environment, 'beta', 1, 'userId');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('INVALID_ENVIRONMENT');
  });
});

describe('validateSegmentKey', () => {
  it.each(['beta-testers', 'A', '0_x', 'a'.repeat(64)])('accepts %j', (key) => {
    expect(validateSegmentKey(key)).toEqual({ ok: true, value: key });
  });

  it.each(['', '-beta', '_beta', 'beta/testers', 'beta testers', 'a'.repeat(65)])('rejects %j', (key) => {
    const result = validateSegmentKey(key);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('INVALID_SEGMENT_KEY');
      expect(result.error.message).toMatch(/Segment keys/);
    }
  });
});
