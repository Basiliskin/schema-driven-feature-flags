import { describe, expect, it, vi } from 'vitest';
import { reviewPendingChangeSet, type ReviewPorts } from '../../src/application/review-pending-change-set.js';
import type { PendingChangeSet } from '../../src/domain/pending-change-set.js';

const snapshot = (features: Record<string, unknown>) => ({
  schemaVersion: 1,
  environment: 'production',
  version: 1,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'test',
  previousVersion: null,
  reason: 'test',
  features,
});

const BASE = snapshot({ alpha: { type: 'boolean', enabled: true, rules: [] } });

const pendingWith = (features: Record<string, unknown>, baseVersion = 3): PendingChangeSet => ({
  baseVersion,
  snapshot: snapshot(features),
});

const ports = (overrides: Partial<ReviewPorts> = {}): ReviewPorts => ({
  readCurrentVersion: () => Promise.resolve(3),
  fetchSnapshotText: () => Promise.resolve(JSON.stringify(BASE)),
  ...overrides,
});

const STAGED = { alpha: { type: 'boolean', enabled: false, rules: [] } };

describe('reviewPendingChangeSet', () => {
  it('returns the flags of the base version and of the staged snapshot, undrifted while the version is unchanged', async () => {
    const fetchSnapshotText = vi.fn(() => Promise.resolve(JSON.stringify(BASE)));

    const review = await reviewPendingChangeSet(ports({ fetchSnapshotText }), 'production', pendingWith(STAGED));

    expect(fetchSnapshotText).toHaveBeenCalledExactlyOnceWith('production', 3);
    expect(review.drifted).toBe(false);
    expect(review.baseFlags?.map((flag) => [flag.key, flag.enabled])).toEqual([['alpha', true]]);
    expect(review.stagedFlags?.map((flag) => [flag.key, flag.enabled])).toEqual([['alpha', false]]);
  });

  it('reads the base flags from the draft version, not the current one, once the environment has moved on', async () => {
    const fetchSnapshotText = vi.fn((_environment: string, version: number) =>
      Promise.resolve(JSON.stringify(version === 2 ? BASE : snapshot({ other: { type: 'boolean', enabled: true, rules: [] } }))),
    );

    const review = await reviewPendingChangeSet(
      ports({ readCurrentVersion: () => Promise.resolve(5), fetchSnapshotText }),
      'production',
      pendingWith(STAGED, 2),
    );

    expect(review.drifted).toBe(true);
    expect(review.baseFlags?.map((flag) => flag.key)).toEqual(['alpha']);
  });

  it('leaves the base side absent when that version was never stored', async () => {
    const missing = Object.assign(new Error('gone'), { reason: 'SNAPSHOT_NOT_FOUND' });

    const review = await reviewPendingChangeSet(
      ports({ fetchSnapshotText: () => Promise.reject(missing) }),
      'production',
      pendingWith(STAGED),
    );

    expect(review.baseFlags).toBeUndefined();
    expect(review.stagedFlags).toHaveLength(1);
  });

  it('leaves the base side absent when that version is not a valid snapshot', async () => {
    const review = await reviewPendingChangeSet(
      ports({ fetchSnapshotText: () => Promise.resolve('{"schemaVersion":2}') }),
      'production',
      pendingWith(STAGED),
    );

    expect(review.baseFlags).toBeUndefined();
  });

  it('leaves the staged side absent when the carried snapshot is not a valid snapshot', async () => {
    const review = await reviewPendingChangeSet(ports(), 'production', { baseVersion: 3, snapshot: { features: 'nope' } });

    expect(review.stagedFlags).toBeUndefined();
    expect(review.baseFlags).toHaveLength(1);
  });

  it('lets an unexpected storage failure through', async () => {
    await expect(
      reviewPendingChangeSet(ports({ fetchSnapshotText: () => Promise.reject(new Error('boom')) }), 'production', pendingWith(STAGED)),
    ).rejects.toThrow('boom');
  });
});
