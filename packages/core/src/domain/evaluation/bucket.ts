const BUCKET_COUNT = 10_000;
const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

const encoder = new TextEncoder();

const rotl32 = (value: number, shift: number): number => (value << shift) | (value >>> (32 - shift));

const scrambleBlock = (block: number): number => Math.imul(rotl32(Math.imul(block, C1), 15), C2);

export const murmur3_32 = (bytes: Uint8Array, seed = 0): number => {
  const length = bytes.length;
  const tailStart = length - (length % 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  let hash = seed;

  for (let i = 0; i < tailStart; i += 4) {
    hash = rotl32(hash ^ scrambleBlock(view.getUint32(i, true)), 13);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }

  let tail = 0;
  for (let i = length - 1; i >= tailStart; i -= 1) {
    tail = (tail << 8) | view.getUint8(i);
  }
  if (length > tailStart) {
    hash ^= scrambleBlock(tail);
  }

  hash ^= length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

export const toCanonicalString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
};

export const computeBucket = (flagKey: string, salt: string, value: unknown): number | undefined => {
  const canonical = toCanonicalString(value);
  if (canonical === undefined) {
    return undefined;
  }
  return murmur3_32(encoder.encode(`${flagKey}:${salt}:${canonical}`)) % BUCKET_COUNT;
};

// round() absorbs float error in percentage * 100 (0.29 * 100 === 28.999999999999996).
export const isInRollout = (bucket: number, percentage: number): boolean => bucket < Math.round(percentage * 100);
