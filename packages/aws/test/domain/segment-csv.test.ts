import { MAX_SEGMENT_MEMBERS, MAX_SEGMENT_MEMBER_LENGTH } from '@featuresync/core';
import { describe, expect, it } from 'vitest';
import { parseSegmentCsv, type SegmentCsvErrorReason } from '../../src/domain/segment-csv.js';

const target = { key: 'beta-testers', version: 3, memberAttribute: 'userId' };

const membersOf = (text: string) => {
  const result = parseSegmentCsv(text, target);
  if (!result.ok) throw new Error(`expected success, got ${result.error.reason}`);
  return result.value.members;
};

const errorOf = (text: string, expected: SegmentCsvErrorReason, options = target) => {
  const result = parseSegmentCsv(text, options);
  if (result.ok) throw new Error('expected the CSV to be rejected');
  expect(result.error.reason).toBe(expected);
  return result.error.message;
};

describe('parseSegmentCsv', () => {
  it('builds a frozen segment with the given key, version and member attribute', () => {
    const result = parseSegmentCsv('alice\nbob\n', target);
    expect(result).toEqual({
      ok: true,
      value: { schemaVersion: 1, key: 'beta-testers', version: 3, memberAttribute: 'userId', members: ['alice', 'bob'] },
    });
    expect(result.ok && Object.isFrozen(result.value.members)).toBe(true);
  });

  it('strips a leading byte order mark from the first member', () => {
    expect(membersOf('\uFEFFalice\nbob')).toEqual(['alice', 'bob']);
  });

  it('strips a byte order mark before detecting the header', () => {
    expect(membersOf('\uFEFFuserId\nalice')).toEqual(['alice']);
  });

  it('handles CRLF line endings without leaving carriage returns in members', () => {
    expect(membersOf('alice\r\nbob\r\n')).toEqual(['alice', 'bob']);
  });

  it('skips blank lines, whitespace-only lines and a trailing newline', () => {
    expect(membersOf('\nalice\n   \n\nbob\n\n')).toEqual(['alice', 'bob']);
  });

  it('trims values before removing duplicates', () => {
    expect(membersOf(' alice \nalice\nbob \n bob')).toEqual(['alice', 'bob']);
  });

  it('keeps members as the exact strings written, so 007 and 7 are different members', () => {
    expect(membersOf('007\n7')).toEqual(['007', '7']);
  });

  it('skips a first line equal to the member attribute as a header', () => {
    expect(membersOf('userId\nalice')).toEqual(['alice']);
  });

  it('treats the first line as a member when it is not the member attribute', () => {
    expect(membersOf('user_id\nalice')).toEqual(['user_id', 'alice']);
  });

  it('normalises BOM, CRLF, header, padding, duplicates and blank lines together', () => {
    expect(membersOf('\uFEFFuserId\r\n alice\r\n\r\nbob \r\nalice\r\n007\r\n\r\n')).toEqual(['alice', 'bob', '007']);
  });

  describe('rejections', () => {
    it.each([
      ['an empty file', ''],
      ['whitespace only', ' \n\r\n\t\n'],
      ['a byte order mark only', '\uFEFF'],
      ['a header only', 'userId\n'],
    ])('rejects %s as EMPTY_FILE', (_, text) => {
      expect(errorOf(text, 'EMPTY_FILE')).toBe('The file holds no members');
    });

    it.each([
      ['a quoted value', 'alice\n"bob"'],
      ['two columns', 'alice\nbob,admin'],
      ['a quoted row with two columns', 'alice\n"a",b'],
    ])('rejects %s as MALFORMED_ROW with its line number', (_, text) => {
      expect(errorOf(text, 'MALFORMED_ROW')).toBe('Line 2 must hold exactly one unquoted value');
    });

    it('counts blank lines when reporting the line number', () => {
      expect(errorOf('alice\n\n\nbob,x', 'MALFORMED_ROW')).toBe('Line 4 must hold exactly one unquoted value');
    });

    it('rejects a header repeated after the first line', () => {
      expect(errorOf('userId\nalice\nuserId\nbob', 'HEADER')).toBe(
        'Line 3 repeats the header; only the first line may be a header',
      );
    });

    it('accepts exactly the member limit', () => {
      const text = Array.from({ length: MAX_SEGMENT_MEMBERS }, (_, index) => `u${String(index)}`).join('\n');
      expect(membersOf(text)).toHaveLength(MAX_SEGMENT_MEMBERS);
    });

    it('rejects one member over the limit as TOO_MANY_MEMBERS', () => {
      const text = Array.from({ length: MAX_SEGMENT_MEMBERS + 1 }, (_, index) => `u${String(index)}`).join('\n');
      expect(errorOf(text, 'TOO_MANY_MEMBERS')).toBe(
        `The file holds ${String(MAX_SEGMENT_MEMBERS + 1)} unique members; the limit is ${String(MAX_SEGMENT_MEMBERS)}`,
      );
    });

    it('checks the member limit after removing duplicates', () => {
      const unique = Array.from({ length: MAX_SEGMENT_MEMBERS }, (_, index) => `u${String(index)}`);
      expect(membersOf([...unique, 'u0', ' u1 '].join('\n'))).toHaveLength(MAX_SEGMENT_MEMBERS);
    });

    it('rejects a member longer than the member length limit as INVALID_SEGMENT without throwing', () => {
      const message = errorOf(`alice\n${'x'.repeat(MAX_SEGMENT_MEMBER_LENGTH + 1)}`, 'INVALID_SEGMENT');
      expect(message).toContain('members[1]');
    });

    it('rejects an invalid segment key as INVALID_SEGMENT', () => {
      expect(errorOf('alice', 'INVALID_SEGMENT', { ...target, key: '-bad key' })).toContain('key');
    });

    it('rejects a non-positive version as INVALID_SEGMENT', () => {
      expect(errorOf('alice', 'INVALID_SEGMENT', { ...target, version: 0 })).toContain('version');
    });
  });

  it('never puts a member value into an error message', () => {
    const secret = 'secret-member-42';
    const long = `${secret}${'x'.repeat(MAX_SEGMENT_MEMBER_LENGTH)}`;
    const many = Array.from({ length: MAX_SEGMENT_MEMBERS + 1 }, (_, index) => `${secret}-${String(index)}`).join('\n');
    const messages = [
      errorOf(`${secret}\n"${secret}"`, 'MALFORMED_ROW'),
      errorOf(`${secret},${secret}`, 'MALFORMED_ROW'),
      errorOf(`userId\n${secret}\nuserId`, 'HEADER'),
      errorOf(many, 'TOO_MANY_MEMBERS'),
      errorOf(`${secret}\n${long}`, 'INVALID_SEGMENT'),
    ];
    for (const message of messages) expect(message).not.toContain(secret);
  });
});
