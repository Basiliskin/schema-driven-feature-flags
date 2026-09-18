import type { Logger } from '@featuresync/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeNotification } from '../../src/domain/change-notification.js';
import { createS3SnapshotSource } from '../../src/infrastructure/s3-snapshot-source.js';
import type { NotificationHandler, NotificationQueue } from '../../src/infrastructure/sqs-notification-queue.js';
import { current, fakeS3, s3Error, type StoredObject } from './fake-s3.js';

const INTERVAL = 1_000;

const notification = (version: number, environment = 'production'): ChangeNotification => ({
  schemaVersion: 1,
  environment,
  version,
  snapshotKey: `${environment}/snapshots/${String(version)}.json`,
});

const snapshot = (version: number): StoredObject => ({ body: JSON.stringify({ v: version }) });

const fakeQueue = () => {
  const stop = vi.fn();
  let handler: NotificationHandler | undefined;
  const queue: NotificationQueue = {
    start: (onNotification) => {
      handler = onNotification;
      return stop;
    },
  };
  const notify = (message: ChangeNotification) => {
    if (handler === undefined) throw new Error('expected the queue to be started');
    return handler(message);
  };
  return { queue, stop, notify };
};

const setup = (objects: Record<string, StoredObject>) => {
  const fake = fakeS3(objects);
  const { queue, stop, notify } = fakeQueue();
  const logger = { error: vi.fn<Logger['error']>() };
  const onChange = vi.fn();
  const source = createS3SnapshotSource({
    bucket: 'flags',
    environment: 'production',
    client: fake.client,
    pollIntervalMs: INTERVAL,
    logger,
    notificationQueue: queue,
  });
  const subscribe = () => {
    if (source.subscribe === undefined) throw new Error('expected a subscribe method');
    return source.subscribe(onChange);
  };
  return { ...fake, objects, source, logger, onChange, subscribe, notify, stop };
};

const untilRead = async (keys: readonly string[], count: number) => {
  while (keys.length < count) await Promise.resolve();
};

const published = (...versions: number[]): Record<string, StoredObject> => ({
  'production/current.json': current(versions[0] ?? 1),
  ...Object.fromEntries(versions.map((version) => [`production/snapshots/${String(version)}.json`, snapshot(version)])),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createS3SnapshotSource push detection', () => {
  it('delivers a newer snapshot as soon as a notification arrives, before any poll tick', async () => {
    const { source, subscribe, onChange, objects, notify } = setup(published(1, 2));
    await source.load();
    subscribe();
    objects['production/current.json'] = current(2);

    await notify(notification(2));

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
  });

  it('re-reads the pointer without a conditional header', async () => {
    const { source, subscribe, notify, send } = setup(published(1));
    await source.load();
    subscribe();

    await notify(notification(1));

    expect(send.mock.lastCall?.[0].input).toEqual({ Bucket: 'flags', Key: 'production/current.json' });
  });

  it('delivers nothing for a duplicate or equal version, from push or from the next poll', async () => {
    const { source, subscribe, onChange, objects, notify, logger } = setup(published(1, 2));
    await source.load();
    subscribe();
    objects['production/current.json'] = current(2);

    await notify(notification(2));
    await notify(notification(2));
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('delivers a rollback only once the current pointer names the lower version', async () => {
    const { source, subscribe, onChange, objects, notify } = setup(published(2, 1));
    await source.load();
    subscribe();

    await notify(notification(1));
    expect(onChange).not.toHaveBeenCalled();

    objects['production/current.json'] = current(1);
    await notify(notification(1));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 1 });
  });

  it('acknowledges a notification for another environment without reading S3', async () => {
    const { subscribe, notify, keys, onChange } = setup(published(1));
    subscribe();

    await expect(notify(notification(3, 'staging'))).resolves.toBeUndefined();

    expect(keys).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rethrows a load failure so the message is left for redelivery, and recovers on the next one', async () => {
    const { source, subscribe, onChange, objects, notify } = setup(published(1));
    await source.load();
    subscribe();
    objects['production/current.json'] = current(2);

    await expect(notify(notification(2))).rejects.toMatchObject({ reason: 'SNAPSHOT_NOT_FOUND' });
    expect(onChange).not.toHaveBeenCalled();

    objects['production/snapshots/2.json'] = snapshot(2);
    await notify(notification(2));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
  });

  it('rethrows a pointer read failure', async () => {
    const { subscribe, objects, notify } = setup(published(1));
    subscribe();
    objects['production/current.json'] = { error: s3Error('InternalError', 500) };

    await expect(notify(notification(2))).rejects.toMatchObject({ reason: 'REQUEST_FAILED' });
  });

  it('stops the queue and the poll loop synchronously on Unsubscribe', async () => {
    const { subscribe, stop, keys } = setup(published(1));
    const unsubscribe = subscribe();

    unsubscribe();
    expect(stop).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(keys).toEqual([]);
  });

  it('never calls onChange for a push load still in flight at Unsubscribe', async () => {
    const { source, subscribe, onChange, objects, notify, keys } = setup(published(1, 2));
    await source.load();
    const unsubscribe = subscribe();
    objects['production/current.json'] = current(2);

    const pending = notify(notification(2));
    await untilRead(keys, 4);
    unsubscribe();
    await pending;

    expect(onChange).not.toHaveBeenCalled();
  });

  it('skips a push queued behind another load once Unsubscribe has run', async () => {
    const { source, subscribe, onChange, objects, notify, keys } = setup(published(1, 2));
    await source.load();
    const unsubscribe = subscribe();
    objects['production/current.json'] = current(2);

    const first = notify(notification(2));
    const second = notify(notification(2));
    await untilRead(keys, 3);
    unsubscribe();
    await Promise.all([first, second]);

    expect(onChange).not.toHaveBeenCalled();
    expect(keys.slice(2)).toEqual(['production/current.json', 'production/snapshots/2.json']);
  });

  it('queues a push behind a pending poll load so snapshots arrive in load order', async () => {
    const { source, subscribe, onChange, objects, notify, send } = setup(published(1, 2, 3));
    await source.load();
    subscribe();
    const answer = send.getMockImplementation();
    if (answer === undefined) throw new Error('expected a fake send implementation');
    let releasePoll = () => {};
    const pollHeld = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    send.mockImplementation((command) =>
      command.input.Key === 'production/snapshots/2.json' ? pollHeld.then(() => answer(command)) : answer(command),
    );
    objects['production/current.json'] = current(2);

    const tick = vi.advanceTimersByTimeAsync(INTERVAL);
    await tick;
    objects['production/current.json'] = current(3);
    const pushed = notify(notification(3));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();

    releasePoll();
    await pushed;

    expect(onChange.mock.calls).toEqual([[{ v: 2 }], [{ v: 3 }]]);
  });

  it('keeps polling after a failed push', async () => {
    const { source, subscribe, onChange, objects, notify } = setup(published(1));
    await source.load();
    subscribe();
    objects['production/current.json'] = current(2);

    await expect(notify(notification(2))).rejects.toThrow();
    objects['production/snapshots/2.json'] = snapshot(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ v: 2 });
  });
});
