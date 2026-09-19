import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeBucket,
  isInRollout,
  murmur3_32,
  toCanonicalString,
} from '../../../src/domain/evaluation/bucket.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('murmur3_32', () => {
  it.each([
    ['', 0, 0],
    ['', 1, 0x514e28b7],
    ['', 0xffffffff, 0x81f16f39],
    ['a', 0x9747b28c, 0x7fa09ea6],
    ['aa', 0x9747b28c, 0x5d211726],
    ['aaa', 0x9747b28c, 0x283e0130],
    ['aaaa', 0x9747b28c, 0x5a97808a],
    ['abc', 0x9747b28c, 0xc84a62dd],
    ['Hello, world!', 0x9747b28c, 0x24884cba],
    ['hello', 0, 0x248bfa47],
    ['The quick brown fox jumps over the lazy dog', 0, 0x2e4ff723],
  ])('hashes %j with seed %i to the reference value', (input, seed, expected) => {
    expect(murmur3_32(utf8(input), seed)).toBe(expected);
  });

  it.each([
    ['привет', 0x3b364b6e],
    ['🚀', 0x7f675865],
    ['new-checkout:2026-q3:ünïcødé', 0xd30797f6],
  ])('hashes the UTF-8 bytes of %j', (input, expected) => {
    expect(murmur3_32(utf8(input))).toBe(expected);
  });

  it('always returns an unsigned 32-bit integer', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.nat(), (bytes, seed) => {
        const hash = murmur3_32(bytes, seed);
        expect(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff).toBe(true);
      }),
    );
  });
});

describe('toCanonicalString', () => {
  it.each([
    ['user-42', 'user-42'],
    ['', ''],
    [18, '18'],
    [18.0, '18'],
    [-7, '-7'],
    [-0, '0'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [Number.MIN_SAFE_INTEGER, '-9007199254740991'],
  ])('turns %j into %j', (value, expected) => {
    expect(toCanonicalString(value)).toBe(expected);
  });

  it.each([true, false, 12345.5, 1e21, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, null, undefined, {}, []])(
    'gives %j no canonical string',
    (value) => {
      expect(toCanonicalString(value)).toBeUndefined();
    },
  );
});

describe('computeBucket', () => {
  it.each([
    ['user-42', 6247],
    [12345, 1891],
    ['ünïcødé', 230],
  ])('matches the spec worked example for %j', (value, bucket) => {
    expect(computeBucket('new-checkout', '2026-q3', value)).toBe(bucket);
  });

  it('hashes flagKey, salt and value joined by colons in that order', () => {
    expect(computeBucket('new-checkout', '2026-q3', 'user-42')).toBe(
      murmur3_32(utf8('new-checkout:2026-q3:user-42')) % 10_000,
    );
    expect(computeBucket('2026-q3', 'new-checkout', 'user-42')).not.toBe(6247);
  });

  it('gives a number and its canonical string the same bucket', () => {
    expect(computeBucket('f', 's', 12345)).toBe(computeBucket('f', 's', '12345'));
  });

  it.each([true, 12345.5, null, undefined, { id: 1 }, ['a']])('puts %j in no bucket', (value) => {
    expect(computeBucket('new-checkout', '2026-q3', value)).toBeUndefined();
  });

  it('always returns a bucket from 0 to 9999', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (flagKey, salt, value) => {
        const bucket = computeBucket(flagKey, salt, value) ?? -1;
        expect(Number.isInteger(bucket) && bucket >= 0 && bucket < 10_000).toBe(true);
      }),
    );
  });
});

describe('isInRollout', () => {
  it('puts no bucket in at 0 percent and every bucket in at 100 percent', () => {
    for (let bucket = 0; bucket < 10_000; bucket += 1) {
      expect(isInRollout(bucket, 0)).toBe(false);
      expect(isInRollout(bucket, 100)).toBe(true);
    }
  });

  it.each([
    [0, 0.01, true],
    [1, 0.01, false],
    [2499, 25, true],
    [2500, 25, false],
    [9998, 99.99, true],
    [9999, 99.99, false],
    [28, 0.29, true],
    [29, 0.29, false],
    [1249, 12.5, true],
    [1250, 12.5, false],
  ])('bucket %i at %d percent is in: %s', (bucket, percentage, expected) => {
    expect(isInRollout(bucket, percentage)).toBe(expected);
  });

  it('only adds buckets when the percentage rises', () => {
    const basisPoints = fc.integer({ min: 0, max: 10_000 });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9999 }), basisPoints, basisPoints, (bucket, a, b) => {
        const [low, high] = a <= b ? [a / 100, b / 100] : [b / 100, a / 100];
        if (isInRollout(bucket, low)) {
          expect(isInRollout(bucket, high)).toBe(true);
        }
      }),
    );
  });
});
