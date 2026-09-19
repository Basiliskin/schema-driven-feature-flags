import { describe, expect, it, vi } from 'vitest';
import { createFeatureFlags } from '../../src/application/flag-client.js';
import type { Logger } from '../../src/application/logger.port.js';
import type { SnapshotBundle, SnapshotSource } from '../../src/application/snapshot-source.port.js';
import { SegmentValidationError } from '../../src/domain/segment-contract.js';
import { validSnapshot } from '../domain/fixtures.js';

const segmentedSnapshot = (version: number, segmentKey = 'beta-testers') => ({
  ...validSnapshot(),
  schemaVersion: 2,
  version,
  previousVersion: null,
  features: {
    beta: {
      type: 'boolean',
      enabled: true,
      rules: [{ when: { userId: { inSegment: segmentKey } }, enabled: true }],
    },
    'new-checkout': {
      type: 'boolean',
      enabled: true,
      rules: [
        {
          when: {},
          rollout: { percentage: 50, bucketBy: 'userId', salt: '2026-q3' },
          enabled: true,
        },
      ],
    },
  },
});

const segment = (members: readonly string[], key = 'beta-testers', version = 1) => ({
  schemaVersion: 1,
  key,
  version,
  memberAttribute: 'userId',
  members,
});

const bundle = (snapshot: unknown, ...segments: unknown[]): SnapshotBundle => ({
  snapshot,
  segments,
});

const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((settle) => (resolve = settle));
  return { promise, resolve };
};

const spyLogger = () => ({ error: vi.fn<Logger['error']>() });

const sourceOf = (...responses: unknown[]) => {
  const load = vi.fn<SnapshotSource['load']>();
  responses.forEach((response) => load.mockResolvedValueOnce(response));
  return { load } satisfies SnapshotSource;
};

const startedClient = async (source: SnapshotSource, logger: Logger = spyLogger()) => {
  const flags = createFeatureFlags({ source, logger });
  await flags.ready();
  return flags;
};

describe('createFeatureFlags with segments', () => {
  it('matches inSegment rules against the bundled segment', async () => {
    const flags = await startedClient(sourceOf(bundle(segmentedSnapshot(1), segment(['u-1', '42']))));

    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(true);
    expect(flags.isEnabled('beta', { userId: 42 })).toBe(true);
    expect(flags.isEnabled('beta', { userId: 'u-2' })).toBe(false);
  });

  it('buckets rollouts by the queried flag key', async () => {
    const flags = await startedClient(sourceOf(segmentedSnapshot(1)));

    expect(flags.isEnabled('new-checkout', { userId: 12345 })).toBe(true);
    expect(flags.isEnabled('new-checkout', { userId: 'user-42' })).toBe(false);
  });

  it('accepts a bare snapshot, whose segment conditions then do not match', async () => {
    const flags = await startedClient(sourceOf(segmentedSnapshot(1)));

    expect(flags.version()).toBe(1);
    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(false);
  });

  it('treats a referenced segment absent from the bundle as missing without throwing', async () => {
    const logger = spyLogger();
    const flags = await startedClient(sourceOf(bundle(segmentedSnapshot(1))), logger);

    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('ignores bundled segments the snapshot does not reference', async () => {
    const flags = await startedClient(
      sourceOf(bundle(segmentedSnapshot(1, 'staff'), segment(['u-1']), segment(['u-2'], 'staff'))),
    );

    expect(flags.isEnabled('beta', { userId: 'u-2' })).toBe(true);
    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(false);
  });

  it('rejects only the invalid segment, and logs positions but never member values', async () => {
    const logger = spyLogger();
    const invalid = segment(['secret-member', 'secret-member']);
    const flags = await startedClient(sourceOf(bundle(segmentedSnapshot(1), invalid)), logger);

    expect(flags.version()).toBe(1);
    expect(flags.isEnabled('beta', { userId: 'secret-member' })).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(SegmentValidationError));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-member');
    expect(String(logger.error.mock.calls[0]?.[1])).not.toContain('secret-member');
  });

  it('keeps the held version of a segment when its new version is invalid or absent', async () => {
    const source = sourceOf(
      bundle(segmentedSnapshot(1), segment(['u-1'])),
      bundle(segmentedSnapshot(2), segment([''], 'beta-testers', 2)),
      bundle(segmentedSnapshot(3)),
    );
    const flags = await startedClient(source);

    await flags.refresh();
    expect(flags.version()).toBe(2);
    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(true);
    await flags.refresh();
    expect(flags.version()).toBe(3);
    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(true);
  });

  it('drops held segments the new snapshot no longer references', async () => {
    const source = sourceOf(
      bundle(segmentedSnapshot(1), segment(['u-1'])),
      bundle(segmentedSnapshot(2, 'staff')),
      bundle(segmentedSnapshot(3)),
    );
    const flags = await startedClient(source);

    await flags.refresh();
    await flags.refresh();

    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(false);
  });

  it('replaces a segment when a newer bundle carries a new version', async () => {
    const source = sourceOf(
      bundle(segmentedSnapshot(1), segment(['u-1'])),
      bundle(segmentedSnapshot(2), segment(['u-2'], 'beta-testers', 2)),
    );
    const flags = await startedClient(source);

    await flags.refresh();

    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(false);
    expect(flags.isEnabled('beta', { userId: 'u-2' })).toBe(true);
  });

  it('rejects a bundle whose segments are not an array and keeps the active one', async () => {
    const logger = spyLogger();
    const source = sourceOf(bundle(segmentedSnapshot(1), segment(['u-1'])), {
      snapshot: segmentedSnapshot(2),
      segments: { 'beta-testers': segment(['u-2']) },
    });
    const flags = await startedClient(source, logger);

    await expect(flags.refresh()).resolves.toBe(false);

    expect(flags.version()).toBe(1);
    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bundle'), expect.any(TypeError));
  });

  it('rejects a bundle whose snapshot is invalid and keeps the active one', async () => {
    const source = sourceOf(bundle(segmentedSnapshot(1), segment(['u-1'])), bundle({ version: 'nope' }));
    const flags = await startedClient(source);

    await expect(flags.refresh()).resolves.toBe(false);
    expect(flags.isEnabled('beta', { userId: 'u-1' })).toBe(true);
  });

  it('never lets a stale ticket replace a newer snapshot and its segments', async () => {
    const slow = deferred();
    const source = sourceOf(bundle(segmentedSnapshot(1), segment(['u-1'])));
    const flags = await startedClient(source);
    source.load
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(bundle(segmentedSnapshot(3), segment(['u-3'], 'beta-testers', 3)));

    const older = flags.refresh();
    await expect(flags.refresh()).resolves.toBe(true);
    slow.resolve(bundle(segmentedSnapshot(2), segment(['u-2'], 'beta-testers', 2)));
    await expect(older).resolves.toBe(false);

    expect(flags.version()).toBe(3);
    expect(flags.isEnabled('beta', { userId: 'u-3' })).toBe(true);
    expect(flags.isEnabled('beta', { userId: 'u-2' })).toBe(false);
  });

  it('answers queries during an update from one consistent snapshot and segment set', async () => {
    const pending = deferred();
    const source = sourceOf(bundle(segmentedSnapshot(1), segment(['u-1'])));
    const flags = await startedClient(source);
    source.load.mockReturnValueOnce(pending.promise);

    const refreshing = flags.refresh();
    expect([flags.version(), flags.isEnabled('beta', { userId: 'u-1' })]).toEqual([1, true]);
    pending.resolve(bundle(segmentedSnapshot(2), segment(['u-2'], 'beta-testers', 2)));
    await refreshing;

    expect([
      flags.version(),
      flags.isEnabled('beta', { userId: 'u-1' }),
      flags.isEnabled('beta', { userId: 'u-2' }),
    ]).toEqual([2, false, true]);
  });
});
