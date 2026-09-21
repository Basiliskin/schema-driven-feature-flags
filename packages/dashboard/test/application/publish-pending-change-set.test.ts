import { describe, expect, it, vi } from 'vitest';
import { EDIT_CONFLICT } from '../../src/application/error-messages.js';
import {
  detectVersionDrift,
  discardPendingChangeSet,
  publishPendingChangeSet,
} from '../../src/application/publish-pending-change-set.js';
import { publishExpecting, type SnapshotWriter } from '../../src/application/publish-snapshot.js';
import { stageFlagEdit } from '../../src/application/stage-flag-edit.js';
import type { FlagEdit } from '../../src/domain/flag-edit.js';
import type { PendingChangeSet } from '../../src/domain/pending-change-set.js';

vi.mock('../../src/application/publish-snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/application/publish-snapshot.js')>();
  return { ...actual, publishExpecting: vi.fn(actual.publishExpecting) };
});

const baseSnapshot = {
  schemaVersion: 1,
  environment: 'production',
  version: 4,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'ci',
  previousVersion: 3,
  reason: 'seed',
  features: {
    'dark-mode': { type: 'boolean', enabled: false },
    'beta-banner': { type: 'boolean', enabled: false },
    'checkout-limits': { type: 'config', enabled: true, default: { max: 3 } },
  },
};

const fakePorts = (currentVersion: number | undefined) => {
  const writer = {
    publish: vi.fn<SnapshotWriter['publish']>(() => Promise.resolve(5)),
    rollback: vi.fn<SnapshotWriter['rollback']>(),
  };
  const openWriter = vi.fn((): SnapshotWriter => writer);
  const readCurrentVersion = vi.fn(() => Promise.resolve(currentVersion));
  const fetchSnapshotText = vi.fn(() => Promise.resolve(JSON.stringify(baseSnapshot)));
  return {
    ports: { readCurrentVersion, fetchSnapshotText, openWriter },
    writer,
    openWriter,
    readCurrentVersion,
    fetchSnapshotText,
  };
};

const enable = (key: string, enabled: boolean): FlagEdit => ({ kind: 'enabled', key, enabled });

const stageAll = async (edits: readonly FlagEdit[]): Promise<PendingChangeSet> => {
  const fake = fakePorts(4);
  let pending: PendingChangeSet | undefined;
  for (const edit of edits) {
    const outcome = await stageFlagEdit(fake.ports, 'production', edit, pending);
    if (outcome.kind !== 'success') throw new Error(`could not stage: ${outcome.message}`);
    pending = outcome.pending;
  }
  if (pending === undefined) throw new Error('nothing staged');
  return pending;
};

const publishOptionsOf = (writer: ReturnType<typeof fakePorts>['writer']) => writer.publish.mock.calls[0]?.[2];

const conflictError = (): Error =>
  Object.assign(new Error('lost the race'), { name: 'S3PublishError', reason: 'CONFLICT' });

describe('publishPendingChangeSet', () => {
  it('publishes three staged edits as exactly one version carrying all of them', async () => {
    const pending = await stageAll([
      enable('dark-mode', true),
      enable('beta-banner', true),
      { kind: 'enabled', key: 'checkout-limits', enabled: false },
    ]);
    const fake = fakePorts(4);

    const outcome = await publishPendingChangeSet(fake.ports, 'production', pending, { force: false });

    expect(outcome).toEqual({ kind: 'success', version: 5, message: 'Published version 5 to production.' });
    expect(fake.writer.publish).toHaveBeenCalledTimes(1);
    const published = fake.writer.publish.mock.calls[0]?.[1] as { features: Record<string, { enabled: boolean }> };
    expect(published).toBe(pending.snapshot);
    expect(published.features['dark-mode']?.enabled).toBe(true);
    expect(published.features['beta-banner']?.enabled).toBe(true);
    expect(published.features['checkout-limits']?.enabled).toBe(false);
  });

  it('expects the Base Version when not forced', async () => {
    const pending = await stageAll([enable('dark-mode', true)]);
    const fake = fakePorts(4);
    vi.mocked(publishExpecting).mockClear();

    await publishPendingChangeSet(fake.ports, 'production', pending, { force: false });

    expect(vi.mocked(publishExpecting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishExpecting).mock.calls[0]?.[3]).toBe(pending.baseVersion);
    expect(publishOptionsOf(fake.writer)).toEqual({ expectedCurrentVersion: 4 });
  });

  it('passes undefined as the expectation when forced, whatever the Base Version', async () => {
    const pending = await stageAll([enable('dark-mode', true)]);
    const fake = fakePorts(9);
    vi.mocked(publishExpecting).mockClear();

    const outcome = await publishPendingChangeSet(fake.ports, 'production', pending, { force: true });

    expect(outcome.kind).toBe('success');
    expect(vi.mocked(publishExpecting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishExpecting).mock.calls[0]).toHaveLength(4);
    expect(vi.mocked(publishExpecting).mock.calls[0]?.[3]).toBeUndefined();
    expect(publishOptionsOf(fake.writer)).toBeUndefined();
    expect(fake.readCurrentVersion).not.toHaveBeenCalled();
  });

  it('reports a drifted, unforced draft as a conflict without publishing again or replaying', async () => {
    const pending = await stageAll([enable('dark-mode', true)]);
    const fake = fakePorts(7);
    fake.writer.publish.mockRejectedValueOnce(conflictError());

    const outcome = await publishPendingChangeSet(fake.ports, 'production', pending, { force: false });

    expect(outcome).toEqual({
      kind: 'failure',
      message: EDIT_CONFLICT(7),
      issues: [],
      conflict: { since: pending.baseVersion },
    });
    expect(fake.writer.publish).toHaveBeenCalledTimes(1);
    expect(fake.openWriter).toHaveBeenCalledTimes(1);
    expect(fake.fetchSnapshotText).not.toHaveBeenCalled();
  });
});

describe('detectVersionDrift', () => {
  const pendingAt = (baseVersion: number): PendingChangeSet => ({ baseVersion, snapshot: baseSnapshot });

  it.each([
    ['equal to the Base Version', 4, false],
    ['ahead of the Base Version', 7, true],
    ['behind the Base Version', 2, true],
    ['missing altogether', undefined, true],
  ])('is decided when the current version is %s', async (_label, current, expected) => {
    const fake = fakePorts(current);

    expect(await detectVersionDrift(fake.ports, 'production', pendingAt(4))).toBe(expected);
    expect(fake.readCurrentVersion).toHaveBeenCalledExactlyOnceWith('production');
  });

  it('only reads the version', async () => {
    const fake = fakePorts(7);

    await detectVersionDrift(fake.ports, 'production', pendingAt(4));

    expect(fake.fetchSnapshotText).not.toHaveBeenCalled();
    expect(fake.openWriter).not.toHaveBeenCalled();
    expect(fake.writer.publish).not.toHaveBeenCalled();
  });
});

describe('discardPendingChangeSet', () => {
  it('returns no Pending Change Set and reaches no port at all', () => {
    const fake = fakePorts(7);

    const discarded = discardPendingChangeSet();

    expect(discarded).toBeUndefined();
    expect(discardPendingChangeSet).toHaveLength(0);
    expect(fake.readCurrentVersion).not.toHaveBeenCalled();
    expect(fake.fetchSnapshotText).not.toHaveBeenCalled();
    expect(fake.openWriter).not.toHaveBeenCalled();
    expect(fake.writer.publish).not.toHaveBeenCalled();
    expect(fake.writer.rollback).not.toHaveBeenCalled();
  });
});
