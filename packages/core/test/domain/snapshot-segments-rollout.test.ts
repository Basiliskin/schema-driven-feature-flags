import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '../../src/domain/snapshot.js';
import { validSnapshot } from './fixtures.js';

const rollout = { percentage: 25, bucketBy: 'userId', salt: '2026-q3' };

const snapshotWith = (schemaVersion: number, rule: Record<string, unknown>, type: 'boolean' | 'config' = 'boolean') => ({
  ...validSnapshot(),
  schemaVersion,
  features: {
    'new-checkout':
      type === 'boolean'
        ? { type, enabled: true, rules: [{ when: {}, enabled: true, ...rule }] }
        : { type, enabled: true, default: 'a', rules: [{ when: {}, value: 'b', ...rule }] },
  },
});

const segmentRule = { when: { userId: { inSegment: 'beta-testers' } } };

const issuesOf = (input: unknown) => {
  const result = parseSnapshot(input);
  if (result.ok) throw new Error('expected validation to fail');
  return result.error.issues;
};

describe('parseSnapshot schema versions', () => {
  it('keeps accepting version 1 snapshots without the new fields', () => {
    expect(parseSnapshot(validSnapshot()).ok).toBe(true);
  });

  it('accepts version 2 snapshots without the new fields', () => {
    expect(parseSnapshot({ ...validSnapshot(), schemaVersion: 2 }).ok).toBe(true);
  });

  it.each([
    ['a boolean rollout', rollout, 'boolean'],
    ['a config rollout', rollout, 'config'],
  ] as const)('accepts %s in version 2', (_, value, type) => {
    const result = parseSnapshot(snapshotWith(2, { rollout: value }, type));

    expect(result.ok && result.value.features['new-checkout']?.rules[0]?.rollout).toEqual(rollout);
  });

  it('accepts an inSegment condition and a rollout together in version 2', () => {
    const result = parseSnapshot(snapshotWith(2, { ...segmentRule, rollout }));

    expect(result.ok && result.value.features['new-checkout']?.rules[0]?.when).toEqual(segmentRule.when);
  });

  it.each([
    ['a rollout', { rollout }, 'features.new-checkout.rules[0]'],
    ['an inSegment condition', segmentRule, 'features.new-checkout.rules[0]'],
  ])('rejects %s in version 1', (_, rule, path) => {
    expect(issuesOf(snapshotWith(1, rule))).toEqual([
      { path, message: 'Segment conditions and rollouts need schemaVersion 2' },
    ]);
  });

  it('rejects a version 1 config rule with a rollout', () => {
    expect(issuesOf(snapshotWith(1, { rollout }, 'config'))).toHaveLength(1);
  });

  it.each([0, 3, '2', null])('rejects schemaVersion %j', (schemaVersion) => {
    expect(issuesOf({ ...validSnapshot(), schemaVersion })[0]?.path).toBe('schemaVersion');
  });
});

describe('parseSnapshot rollout validation', () => {
  it.each([0, 100, 0.01, 12.5, 99.99, 0.29])('accepts percentage %d', (percentage) => {
    expect(parseSnapshot(snapshotWith(2, { rollout: { ...rollout, percentage } })).ok).toBe(true);
  });

  it.each([
    ['percentage', -0.01],
    ['percentage', 100.01],
    ['percentage', 12.345],
    ['percentage', Number.NaN],
    ['percentage', Infinity],
    ['percentage', '25'],
    ['bucketBy', ''],
    ['bucketBy', 7],
    ['salt', ''],
    ['salt', null],
  ])('rejects %s = %j', (field, value) => {
    expect(issuesOf(snapshotWith(2, { rollout: { ...rollout, [field]: value } }))[0]?.path).toBe(
      `features.new-checkout.rules[0].rollout.${field}`,
    );
  });

  it.each(['percentage', 'bucketBy', 'salt'])('rejects a rollout without %s', (field) => {
    const partial = Object.fromEntries(Object.entries({ ...rollout }).filter(([name]) => name !== field));

    expect(issuesOf(snapshotWith(2, { rollout: partial }))[0]?.path).toBe(
      `features.new-checkout.rules[0].rollout.${field}`,
    );
  });

  it('rejects unknown keys inside a rollout', () => {
    expect(issuesOf(snapshotWith(2, { rollout: { ...rollout, sticky: true } }))[0]?.path).toBe(
      'features.new-checkout.rules[0].rollout',
    );
  });

  it.each([null, 25, 'userId'])('rejects rollout %j', (value) => {
    expect(issuesOf(snapshotWith(2, { rollout: value }))[0]?.path).toBe('features.new-checkout.rules[0].rollout');
  });
});

describe('parseSnapshot segment references', () => {
  it.each(['', 'no/slash', '-dash', 'k'.repeat(65), 42, null])('rejects inSegment key %j', (key) => {
    expect(issuesOf(snapshotWith(2, { when: { userId: { inSegment: key } } }))).not.toHaveLength(0);
  });

  it('rejects inSegment combined with another operator', () => {
    expect(issuesOf(snapshotWith(2, { when: { userId: { inSegment: 'beta', equals: 'x' } } }))).not.toHaveLength(0);
  });
});
