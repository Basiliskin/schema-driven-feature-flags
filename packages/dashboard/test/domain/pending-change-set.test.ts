import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_CHANGE_SET_BYTES,
  parsePendingChangeSet,
  serializePendingChangeSet,
  type PendingChangeSet,
} from '../../src/domain/pending-change-set.js';

const set = (overrides: Partial<PendingChangeSet> = {}): PendingChangeSet => ({
  baseVersion: 3,
  snapshot: { schemaVersion: 2, features: { alpha: { type: 'boolean', enabled: true, default: true, rules: [] } } },
  ...overrides,
});

const oversized = (): string => {
  const padding = 'x'.repeat(MAX_PENDING_CHANGE_SET_BYTES);
  return serializePendingChangeSet(set({ snapshot: { reason: padding } }));
};

describe('serializePendingChangeSet', () => {
  it('round-trips a multi-flag snapshot with nested values', () => {
    const original = set({
      snapshot: {
        schemaVersion: 2,
        features: {
          alpha: { type: 'boolean', enabled: true, default: false, rules: [] },
          beta: {
            type: 'config',
            enabled: true,
            default: { retries: 3, hosts: ['a', 'b'] },
            rules: [{ segmentKey: 'staff', memberAttribute: 'userId', value: { retries: 9 } }],
          },
        },
      },
    });

    const parsed = parsePendingChangeSet(serializePendingChangeSet(original));

    expect(parsed).toEqual(original);
    expect(typeof parsed?.baseVersion).toBe('number');
  });

  it('emits nothing that would break an HTML value attribute', () => {
    const serialized = serializePendingChangeSet(set({ snapshot: { reason: 'she said "ship it"\nthen left' } }));

    expect(serialized).not.toContain('"');
    expect(serialized).not.toContain('\n');
    expect(parsePendingChangeSet(serialized)?.snapshot).toEqual({ reason: 'she said "ship it"\nthen left' });
  });
});

describe('parsePendingChangeSet', () => {
  it('reads an absent field as no pending changes', () => {
    expect(parsePendingChangeSet(undefined)).toBeUndefined();
    expect(parsePendingChangeSet(null)).toBeUndefined();
    expect(parsePendingChangeSet('')).toBeUndefined();
  });

  it('reads a non-string field as no pending changes', () => {
    expect(parsePendingChangeSet(7 as unknown as string)).toBeUndefined();
  });

  it('reads malformed encoding as no pending changes', () => {
    expect(parsePendingChangeSet('%E0%A4%A')).toBeUndefined();
    expect(parsePendingChangeSet('kj%20nonsense%20here')).toBeUndefined();
  });

  it('reads valid JSON of the wrong shape as no pending changes', () => {
    const encode = (value: unknown): string => encodeURIComponent(JSON.stringify(value));

    expect(parsePendingChangeSet(encode([1, 2]))).toBeUndefined();
    expect(parsePendingChangeSet(encode('a string'))).toBeUndefined();
    expect(parsePendingChangeSet(encode({ snapshot: {} }))).toBeUndefined();
    expect(parsePendingChangeSet(encode({ baseVersion: 3 }))).toBeUndefined();
    expect(parsePendingChangeSet(encode({ baseVersion: '3', snapshot: {} }))).toBeUndefined();
    expect(parsePendingChangeSet(encode({ baseVersion: 0, snapshot: {} }))).toBeUndefined();
    expect(parsePendingChangeSet(encode({ baseVersion: 1.5, snapshot: {} }))).toBeUndefined();
    expect(parsePendingChangeSet(encode({ baseVersion: 3, snapshot: [] }))).toBeUndefined();
    expect(parsePendingChangeSet(encode({ baseVersion: 3, snapshot: null }))).toBeUndefined();
  });

  it('reads an over-budget payload as no pending changes', () => {
    expect(parsePendingChangeSet(oversized())).toBeUndefined();
  });

  it('still parses a payload just under the budget', () => {
    const padding = 'x'.repeat(MAX_PENDING_CHANGE_SET_BYTES - 200);
    const serialized = serializePendingChangeSet(set({ snapshot: { reason: padding } }));

    expect(serialized.length).toBeLessThanOrEqual(MAX_PENDING_CHANGE_SET_BYTES);
    expect(parsePendingChangeSet(serialized)?.snapshot).toEqual({ reason: padding });
  });

  it('measures the budget in bytes, not characters', () => {
    const multiByte = '✓'.repeat(MAX_PENDING_CHANGE_SET_BYTES);

    expect(multiByte.length).toBeLessThan(MAX_PENDING_CHANGE_SET_BYTES * 3);
    expect(parsePendingChangeSet(multiByte)).toBeUndefined();
  });
});
