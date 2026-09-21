import { describe, expect, it, vi } from 'vitest';
import {
  EDITED_SNAPSHOT_INVALID_MESSAGE,
  FETCH_ERROR_MESSAGES,
  UNKNOWN_FEATURE_MESSAGE,
} from '../../src/application/error-messages.js';
import type { EditFeaturePorts } from '../../src/application/edit-feature.js';
import type { SnapshotWriter } from '../../src/application/publish-snapshot.js';
import {
  NOTHING_TO_EDIT_MESSAGE,
  STAGED_MESSAGE,
  stageFlagEdit,
  type StageOutcome,
} from '../../src/application/stage-flag-edit.js';
import type { FlagEdit } from '../../src/domain/flag-edit.js';
import type { PendingChangeSet } from '../../src/domain/pending-change-set.js';

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
    'checkout-limits': { type: 'config', enabled: true, default: { max: 3 } },
  },
};

interface FakeOptions {
  readonly fetch?: () => Promise<string>;
  readonly pointer?: () => Promise<number | undefined>;
}

const fakePorts = (options: FakeOptions = {}) => {
  const writer = {
    publish: vi.fn<SnapshotWriter['publish']>(),
    rollback: vi.fn<SnapshotWriter['rollback']>(),
  };
  const openWriter = vi.fn((): SnapshotWriter => writer);
  const fetchSnapshotText = vi.fn<EditFeaturePorts['fetchSnapshotText']>(
    () => options.fetch?.() ?? Promise.resolve(JSON.stringify(baseSnapshot)),
  );
  const readCurrentVersion = vi.fn<EditFeaturePorts['readCurrentVersion']>(
    () => options.pointer?.() ?? Promise.resolve(4),
  );
  return { ports: { fetchSnapshotText, readCurrentVersion, openWriter }, writer, openWriter };
};

const enable = (key: string, enabled: boolean): FlagEdit => ({ kind: 'enabled', key, enabled });

const staged = (outcome: StageOutcome): PendingChangeSet => {
  if (outcome.kind !== 'success') throw new Error(`expected a staged set, got: ${outcome.message}`);
  return outcome.pending;
};

const featuresOf = (set: PendingChangeSet): Record<string, { enabled?: boolean }> =>
  set.snapshot.features as Record<string, { enabled?: boolean }>;

const expectNoWrites = (fake: ReturnType<typeof fakePorts>): void => {
  expect(fake.openWriter).not.toHaveBeenCalled();
  expect(fake.writer.publish).not.toHaveBeenCalled();
  expect(fake.writer.rollback).not.toHaveBeenCalled();
};

describe('stageFlagEdit seeding a new Pending Change Set', () => {
  it('takes its Base Version from the environment and writes nothing', async () => {
    const fake = fakePorts();

    const outcome = await stageFlagEdit(fake.ports, 'production', enable('dark-mode', true), undefined);

    expect(outcome.kind).toBe('success');
    expect(outcome.message).toBe(STAGED_MESSAGE);
    expect(staged(outcome).baseVersion).toBe(4);
    expect(featuresOf(staged(outcome))['dark-mode']?.enabled).toBe(true);
    expect(fake.ports.readCurrentVersion).toHaveBeenCalledWith('production');
    expectNoWrites(fake);
  });

  it('refuses when the environment has no published version yet', async () => {
    const fake = fakePorts({ pointer: () => Promise.resolve(undefined) });

    const outcome = await stageFlagEdit(fake.ports, 'production', enable('dark-mode', true), undefined);

    expect(outcome).toEqual({ kind: 'failure', message: NOTHING_TO_EDIT_MESSAGE, issues: [] });
    expect(fake.ports.fetchSnapshotText).not.toHaveBeenCalled();
    expectNoWrites(fake);
  });

  it('reports a failed snapshot read as a failure outcome rather than throwing', async () => {
    const fake = fakePorts({
      fetch: () => Promise.reject(Object.assign(new Error('gone'), { name: 'S3FetchError', reason: 'SNAPSHOT_NOT_FOUND' })),
    });

    const outcome = await stageFlagEdit(fake.ports, 'production', enable('dark-mode', true), undefined);

    expect(outcome.kind).toBe('failure');
    expect(outcome.message).toBe(FETCH_ERROR_MESSAGES.SNAPSHOT_NOT_FOUND);
    expectNoWrites(fake);
  });
});

describe('stageFlagEdit accumulating onto an existing Pending Change Set', () => {
  it('applies onto the accumulated snapshot and never re-reads the environment', async () => {
    const fake = fakePorts({ pointer: () => Promise.resolve(7) });
    const first = staged(await stageFlagEdit(fake.ports, 'production', enable('dark-mode', true), undefined));
    fake.ports.readCurrentVersion.mockClear();
    fake.ports.fetchSnapshotText.mockClear();

    const second = staged(
      await stageFlagEdit(fake.ports, 'production', enable('checkout-limits', false), first),
    );

    expect(featuresOf(second)['dark-mode']?.enabled).toBe(true);
    expect(featuresOf(second)['checkout-limits']?.enabled).toBe(false);
    expect(fake.ports.readCurrentVersion).not.toHaveBeenCalled();
    expect(fake.ports.fetchSnapshotText).not.toHaveBeenCalled();
    expectNoWrites(fake);
  });

  it('keeps the frozen Base Version even when the environment has moved on', async () => {
    const fake = fakePorts({ pointer: () => Promise.resolve(7) });
    const pending: PendingChangeSet = { baseVersion: 3, snapshot: { ...baseSnapshot } };

    const outcome = await stageFlagEdit(fake.ports, 'production', enable('dark-mode', true), pending);

    expect(staged(outcome).baseVersion).toBe(3);
    expectNoWrites(fake);
  });
});

describe('stageFlagEdit rejecting an invalid edit', () => {
  it('fails an unknown flag and leaves the supplied set untouched', async () => {
    const fake = fakePorts();
    const first = staged(await stageFlagEdit(fake.ports, 'production', enable('dark-mode', true), undefined));
    const before = structuredClone(first);

    const outcome = await stageFlagEdit(fake.ports, 'production', enable('no-such-flag', true), first);

    expect(outcome).toEqual({ kind: 'failure', message: UNKNOWN_FEATURE_MESSAGE('no-such-flag'), issues: [] });
    expect(first).toEqual(before);
    expect(featuresOf(first)['dark-mode']?.enabled).toBe(true);
    expectNoWrites(fake);
  });

  it('fails a schema-invalid value through applyFlagEdit, not a local check', async () => {
    const fake = fakePorts();

    const outcome = await stageFlagEdit(
      fake.ports,
      'production',
      { kind: 'setRules', key: 'dark-mode', rulesJson: '[{"when":42}]' },
      undefined,
    );

    expect(outcome.kind).toBe('failure');
    expect(outcome.message).toBe(EDITED_SNAPSHOT_INVALID_MESSAGE);
    expect(outcome.kind === 'failure' && outcome.issues.length).toBeGreaterThan(0);
    expectNoWrites(fake);
  });
});
