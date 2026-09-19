import { describe, expect, it } from 'vitest';
import {
  MAX_SEGMENT_MEMBERS,
  parseSegment,
  SegmentValidationError,
  type Segment,
} from '../../src/domain/segment-contract.js';

const validSegment = () => ({
  schemaVersion: 1,
  key: 'beta-testers',
  version: 2,
  memberAttribute: 'userId',
  members: ['user-42', 'user-77', '12345'],
});

const parseOk = (input: unknown): Segment => {
  const result = parseSegment(input);
  if (!result.ok) throw result.error;
  return result.value;
};

const errorOf = (input: unknown): SegmentValidationError => {
  const result = parseSegment(input);
  if (result.ok) throw new Error('expected validation to fail');
  expect(result.error).toBeInstanceOf(SegmentValidationError);
  return result.error;
};

const membersOf = (count: number): string[] => Array.from({ length: count }, (_, index) => `member-${String(index)}`);

describe('parseSegment', () => {
  it('parses a valid segment and freezes it', () => {
    const segment = parseOk(validSegment());

    expect(segment).toEqual(validSegment());
    expect(Object.isFrozen(segment)).toBe(true);
    expect(Object.isFrozen(segment.members)).toBe(true);
  });

  it('ignores unknown extra fields', () => {
    expect(parseOk({ ...validSegment(), uploadedBy: 'ops' })).toEqual(validSegment());
  });

  it('accepts an empty member list', () => {
    expect(parseOk({ ...validSegment(), members: [] }).members).toEqual([]);
  });

  it.each(['schemaVersion', 'key', 'version', 'memberAttribute', 'members'])('rejects a segment without %s', (field) => {
    const input = Object.fromEntries(Object.entries(validSegment()).filter(([name]) => name !== field));

    expect(errorOf(input).issues.map((issue) => issue.path)).toEqual([field]);
  });

  it.each([
    ['schemaVersion', 2],
    ['key', 'no/slash'],
    ['key', '-leading-dash'],
    ['key', 'k'.repeat(65)],
    ['version', 0],
    ['version', 1.5],
    ['memberAttribute', ''],
    ['members', 'user-42'],
  ])('rejects %s = %j', (field, value) => {
    expect(errorOf({ ...validSegment(), [field]: value }).issues[0]?.path).toBe(field);
  });

  it('accepts a 64-character key', () => {
    expect(parseOk({ ...validSegment(), key: 'k'.repeat(64) }).key).toHaveLength(64);
  });

  it('accepts exactly the maximum member count and rejects one more', () => {
    expect(parseOk({ ...validSegment(), members: membersOf(MAX_SEGMENT_MEMBERS) }).members).toHaveLength(
      MAX_SEGMENT_MEMBERS,
    );
    expect(errorOf({ ...validSegment(), members: membersOf(MAX_SEGMENT_MEMBERS + 1) }).issues).toEqual([
      { path: 'members', message: `A segment holds at most ${String(MAX_SEGMENT_MEMBERS)} members` },
    ]);
  });

  it('accepts a 256-character member and rejects a 257-character one', () => {
    expect(parseOk({ ...validSegment(), members: ['m'.repeat(256)] }).members).toHaveLength(1);
    expect(errorOf({ ...validSegment(), members: ['m'.repeat(257)] }).issues[0]?.path).toBe('members[0]');
  });

  it.each([
    [['user-42', ''], 'members[1]'],
    [['user-42', 12345], 'members[1]'],
    [['user-42', 'user-77', 'user-42'], 'members[2]'],
  ])('rejects the bad member in %j by position', (members, path) => {
    expect(errorOf({ ...validSegment(), members }).issues[0]?.path).toBe(path);
  });

  it('never puts a member value into an error', () => {
    const secret = 'alice@example.com';
    const inputs = [
      { ...validSegment(), members: [secret, secret] },
      { ...validSegment(), members: [secret, `${secret}${'x'.repeat(300)}`] },
      { ...validSegment(), members: [secret, 42], key: 'bad key' },
      { ...validSegment(), members: [secret, ...membersOf(MAX_SEGMENT_MEMBERS)] },
    ];

    for (const input of inputs) {
      const error = errorOf(input);
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error.issues)).not.toContain(secret);
    }
  });
});
