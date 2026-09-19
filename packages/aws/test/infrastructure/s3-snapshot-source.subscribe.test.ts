import type { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Logger } from '@featuresync/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3SnapshotError } from '../../src/infrastructure/s3-snapshot-error.js';
import {
  createS3SnapshotSource,
  type S3SnapshotSourceOptions,
} from '../../src/infrastructure/s3-snapshot-source.js';
import {
  current,
  fakeS3,
  pointer,
  publishedSegment,
  s3Error,
  segmentFile,
  snapshotUsing,
  type StoredObject,
} from './fake-s3.js';

const INTERVAL = 1_000;

const setup = (
  objects: Record<string, StoredObject>,
  options: Partial<S3SnapshotSourceOptions> & { notModified?: () => Error } = {},
) => {
  const { notModified, ...sourceOptions } = options;
  const fake = fakeS3(objects, notModified);
  const logger = { error: vi.fn<Logger['error']>() };
  const onChange = vi.fn();
  const source = createS3SnapshotSource({
    bucket: 'flags',
    environment: 'production',
    client: fake.client,
    pollIntervalMs: INTERVAL,
    logger,
    ...sourceOptions,
  });
  const subscribe = () => {
    if (source.subscribe === undefined) throw new Error('expected a subscribe method');
    return source.subscribe(onChange);
  };
  const ifNoneMatchSent = () =>
    fake.send.mock.calls.map(([command]: [GetObjectCommand]) => command.input.IfNoneMatch);
  return { ...fake, source, logger, onChange, subscribe, ifNoneMatchSent };
};

const published = (version: number): Record<string, StoredObject> => ({
  'production/current.json': current(version),
  [`production/snapshots/${String(version)}.json`]: { body: JSON.stringify({ v: version }) },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createS3SnapshotSource subscribe', () => {
  it('waits one interval before the first poll tick', async () => {
    const { subscribe, keys } = setup(published(1));
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(keys).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(keys).toEqual(['production/current.json', 'production/snapshots/1.json']);
  });

  it('delivers the first version seen when nothing was loaded, without a conditional header', async () => {
    const { subscribe, onChange, ifNoneMatchSent } = setup(published(1));
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 1 });
    expect(ifNoneMatchSent()).toEqual([undefined, undefined]);
  });

  it.each([
    ['a 304 status', () => s3Error('NotModified', 304)],
    ['the NotModified error name alone', () => Object.assign(new Error('not modified'), { name: 'NotModified' })],
    ['a 304 status under another name', () => s3Error('Unknown', 304)],
  ])('treats %s as no change', async (_, notModified) => {
    const { source, subscribe, onChange, keys, logger, ifNoneMatchSent } = setup(published(1), { notModified });
    await source.load();
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(onChange).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(keys.slice(2)).toEqual(['production/current.json', 'production/current.json']);
    expect(ifNoneMatchSent().slice(2)).toEqual(['"v1"', '"v1"']);
  });

  it('delivers nothing when the pointer changes but its version does not, and adopts the new ETag', async () => {
    const objects = published(2);
    const { source, subscribe, onChange, keys, ifNoneMatchSent } = setup(objects);
    await source.load();
    subscribe();

    objects['production/current.json'] = current(2, '"rewritten"');
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(onChange).not.toHaveBeenCalled();
    expect(keys.slice(2)).toEqual(['production/current.json', 'production/current.json']);
    expect(ifNoneMatchSent().slice(2)).toEqual(['"v2"', '"rewritten"']);
  });

  it('keeps the known ETag when an unchanged version arrives without one', async () => {
    const objects = published(2);
    const { source, subscribe, onChange, ifNoneMatchSent } = setup(objects);
    await source.load();
    subscribe();

    objects['production/current.json'] = { body: JSON.stringify(pointer(2)) };
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(onChange).not.toHaveBeenCalled();
    expect(ifNoneMatchSent().slice(2)).toEqual(['"v2"', '"v2"']);
  });

  it('loads and delivers the raw snapshot of a new version once', async () => {
    const objects = { ...published(1), ...published(2), 'production/current.json': current(1) };
    const { source, subscribe, onChange } = setup(objects);
    await source.load();
    subscribe();

    objects['production/current.json'] = current(2);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
    await expect(source.load()).resolves.toEqual({ v: 2 });
  });

  it('delivers a new version the pointer rolls back to', async () => {
    const objects = { ...published(1), ...published(2) };
    const { source, subscribe, onChange } = setup(objects);
    await source.load();
    subscribe();

    objects['production/current.json'] = current(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 1 });
  });

  it('logs a failed tick, keeps the active snapshot, and delivers once S3 recovers', async () => {
    const objects = { ...published(1), ...published(2), 'production/current.json': current(1) };
    const { source, subscribe, onChange, logger } = setup(objects);
    await source.load();
    subscribe();

    const outage = s3Error('InternalError', 500);
    objects['production/current.json'] = { error: outage };
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Cannot poll the S3 snapshot pointer; keeping the active snapshot',
      expect.any(S3SnapshotError),
    );
    const [[, logged]] = logger.error.mock.calls as [[string, S3SnapshotError]];
    expect(logged.reason).toBe('REQUEST_FAILED');
    expect(logged.cause).toBe(outage);

    objects['production/current.json'] = current(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
  });

  it('retries a version whose snapshot failed to load instead of treating its pointer as seen', async () => {
    const objects: Record<string, StoredObject> = {
      ...published(1),
      'production/current.json': current(2),
      'production/snapshots/2.json': { error: s3Error('InternalError', 500) },
    };
    const { subscribe, onChange, logger } = setup(objects);
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(logger.error).toHaveBeenCalledOnce();

    objects['production/snapshots/2.json'] = { body: '{"v":2}' };
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
  });

  it('logs an invalid pointer and keeps polling', async () => {
    const objects = published(1);
    const { subscribe, logger, keys } = setup(objects);
    objects['production/current.json'] = { body: '{', etag: '"broken"' };
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(keys).toEqual(['production/current.json', 'production/current.json']);
  });

  it('never starts a tick while the previous one is still running', async () => {
    const { client, send } = fakeS3(published(1));
    let release: (() => void) | undefined;
    send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          release = () => {
            reject(s3Error('InternalError', 500));
          };
        }),
    );
    const source = createS3SnapshotSource({
      bucket: 'flags',
      environment: 'production',
      client,
      pollIntervalMs: INTERVAL,
      logger: { error: vi.fn() },
    });
    source.subscribe?.(vi.fn());

    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(send).toHaveBeenCalledOnce();

    release?.();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('stops polling on unsubscribe', async () => {
    const { subscribe, keys } = setup(published(1));
    const unsubscribe = subscribe();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const requests = keys.length;

    unsubscribe();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(keys).toHaveLength(requests);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delivers nothing and schedules nothing when unsubscribed during an in-flight tick', async () => {
    const objects = published(1);
    const { client, send } = fakeS3(objects);
    let release: (() => void) | undefined;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({
              ETag: '"v1"',
              Body: { transformToString: () => Promise.resolve(JSON.stringify(pointer(1))) },
            });
          };
        }),
    );
    const onChange = vi.fn();
    const source = createS3SnapshotSource({
      bucket: 'flags',
      environment: 'production',
      client,
      pollIntervalMs: INTERVAL,
    });
    const unsubscribe = source.subscribe?.(onChange);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    unsubscribe?.();
    release?.();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(onChange).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delivers one bundle with the segments of a new version', async () => {
    const snapshot = snapshotUsing('staff');
    const { subscribe, onChange } = setup({
      'production/current.json': current(1),
      'production/snapshots/1.json': { body: JSON.stringify(snapshot) },
      ...publishedSegment('staff', 3),
    });
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ snapshot, segments: [segmentFile('staff', 3)] });
  });

  it('delivers nothing when unsubscribed while segments are still loading', async () => {
    const segmentKey = 'production/segments/staff/1.json';
    const objects: Record<string, StoredObject> = {
      'production/current.json': current(1),
      'production/snapshots/1.json': { body: JSON.stringify(snapshotUsing('staff')) },
      ...publishedSegment('staff', 1),
    };
    const { client, send } = fakeS3(objects);
    const answer = send.getMockImplementation();
    if (answer === undefined) throw new Error('expected a fake S3 implementation');
    let release: (() => void) | undefined;
    send.mockImplementation((command: GetObjectCommand) =>
      command.input.Key === segmentKey
        ? new Promise((resolve) => {
            release = () => {
              resolve(answer(command));
            };
          })
        : answer(command),
    );
    const onChange = vi.fn();
    const source = createS3SnapshotSource({ bucket: 'flags', environment: 'production', client, pollIntervalMs: INTERVAL });
    const unsubscribe = source.subscribe?.(onChange);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    unsubscribe?.();
    release?.();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(release).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls every 30 seconds by default', async () => {
    const { client, keys } = fakeS3(published(1));
    createS3SnapshotSource({ bucket: 'flags', environment: 'production', client }).subscribe?.(vi.fn());

    await vi.advanceTimersByTimeAsync(29_999);
    expect(keys).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(keys).not.toEqual([]);
  });

  it('logs to console.error by default', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = fakeS3({});
    const source = createS3SnapshotSource({
      bucket: 'flags',
      environment: 'production',
      client,
      pollIntervalMs: INTERVAL,
    });
    source.subscribe?.(vi.fn());

    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      '[featuresync] Cannot poll the S3 snapshot pointer; keeping the active snapshot',
      expect.any(S3SnapshotError),
    );
    consoleError.mockRestore();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a pollIntervalMs of %s', (pollIntervalMs) => {
    expect(() => createS3SnapshotSource({ bucket: 'flags', environment: 'production', pollIntervalMs })).toThrow(
      new RangeError(`pollIntervalMs must be a positive number, got ${String(pollIntervalMs)}`),
    );
  });
});

describe('createS3SnapshotSource reconciliation', () => {
  const RECONCILE = INTERVAL * 3;

  it('delivers a new version on a reconciliation tick even when the pointer kept a stale ETag', async () => {
    const objects = { ...published(1), ...published(2), 'production/current.json': current(1) };
    const { source, subscribe, onChange, ifNoneMatchSent } = setup(objects, { reconcileIntervalMs: RECONCILE });
    await source.load();
    subscribe();

    objects['production/current.json'] = current(2, '"v1"');
    await vi.advanceTimersByTimeAsync(RECONCILE - INTERVAL);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
    expect(ifNoneMatchSent().slice(2)).toEqual(['"v1"', '"v1"', undefined, undefined]);
  });

  it('logs a snapshot that fails to load on a reconciliation tick and retries it on the next one', async () => {
    const objects: Record<string, StoredObject> = {
      ...published(1),
      'production/snapshots/2.json': { error: s3Error('InternalError', 500) },
    };
    const { source, subscribe, onChange, logger } = setup(objects, { reconcileIntervalMs: RECONCILE });
    await source.load();
    subscribe();
    objects['production/current.json'] = current(2, '"v1"');

    await vi.advanceTimersByTimeAsync(RECONCILE);
    expect(onChange).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Cannot poll the S3 snapshot pointer; keeping the active snapshot',
      expect.any(S3SnapshotError),
    );

    objects['production/snapshots/2.json'] = { body: '{"v":2}' };
    await vi.advanceTimersByTimeAsync(RECONCILE - INTERVAL);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
  });

  it('delivers nothing for an unchanged version, adopts the reconciled ETag, and reconciles again', async () => {
    const objects = published(1);
    const { source, subscribe, onChange, keys, ifNoneMatchSent } = setup(objects, {
      reconcileIntervalMs: RECONCILE,
    });
    await source.load();
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL * 2.5);
    objects['production/current.json'] = current(1, '"fresh"');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3.5);

    expect(onChange).not.toHaveBeenCalled();
    expect(keys.slice(2).every((key) => key === 'production/current.json')).toBe(true);
    expect(ifNoneMatchSent().slice(2)).toEqual(['"v1"', '"v1"', undefined, '"fresh"', '"fresh"', undefined]);
  });

  it('reconciles on every tick when both intervals are equal', async () => {
    const { source, subscribe, ifNoneMatchSent } = setup(published(1), { reconcileIntervalMs: INTERVAL });
    await source.load();
    subscribe();

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(ifNoneMatchSent().slice(2)).toEqual([undefined, undefined]);
  });

  it('reconciles every 10 minutes by default', async () => {
    const { source, subscribe, ifNoneMatchSent } = setup(published(1), { pollIntervalMs: 60_000 });
    await source.load();
    subscribe();

    await vi.advanceTimersByTimeAsync(600_000);

    expect(ifNoneMatchSent().slice(2)).toEqual([...Array<string>(9).fill('"v1"'), undefined]);
  });

  it('leaves no timer behind after unsubscribing', async () => {
    const { subscribe } = setup(published(1), { reconcileIntervalMs: RECONCILE });
    const unsubscribe = subscribe();
    await vi.advanceTimersByTimeAsync(RECONCILE);

    unsubscribe();

    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([INTERVAL - 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a reconcileIntervalMs of %s',
    (reconcileIntervalMs) => {
      expect(() =>
        createS3SnapshotSource({
          bucket: 'flags',
          environment: 'production',
          pollIntervalMs: INTERVAL,
          reconcileIntervalMs,
        }),
      ).toThrow(
        new RangeError(
          `reconcileIntervalMs must be a finite number no smaller than pollIntervalMs (${String(INTERVAL)}), got ${String(reconcileIntervalMs)}`,
        ),
      );
    },
  );
});
