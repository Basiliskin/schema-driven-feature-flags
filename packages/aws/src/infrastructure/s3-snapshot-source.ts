import { S3Client } from '@aws-sdk/client-s3';
import type { Logger, SnapshotSource, Unsubscribe } from '@featuresync/core';
import { parseCurrentPointer, snapshotKeyFor, type CurrentPointer } from '../domain/current-pointer.js';
import { errorShape } from './s3-errors.js';
import { isMissing, parseJsonObject, readObjectText, type S3Text } from './s3-read.js';
import { S3SnapshotError } from './s3-snapshot-error.js';
import type { NotificationQueue } from './sqs-notification-queue.js';

/** Options for {@link createS3SnapshotSource}. */
export interface S3SnapshotSourceOptions {
  readonly bucket: string;
  readonly environment: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
  /** Delay between the end of one check of the current pointer and the start of the next. Defaults to 30 seconds. */
  readonly pollIntervalMs?: number;
  /**
   * How often a poll tick re-reads the current pointer without a conditional header, catching changes
   * an ETag comparison missed. Must be at least `pollIntervalMs`. Defaults to 10 minutes.
   */
  readonly reconcileIntervalMs?: number;
  /** Receives S3 failures seen while polling. Defaults to `console.error`. */
  readonly logger?: Logger;
  /**
   * Change Notifications that trigger an immediate re-read of the current pointer, alongside polling.
   * A notification is only a hint: the pointer decides which snapshot is delivered, so a rollback is
   * delivered once `current.json` names the lower version.
   */
  readonly notificationQueue?: NotificationQueue;
}

interface LoadedSnapshot {
  readonly etag: string;
  readonly version: number;
  readonly snapshot: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 600_000;

const consoleLogger: Logger = {
  error: (message, error) => {
    console.error(`[featuresync] ${message}`, error);
  },
};

// The SDK has no NotModified exception class; a 304 surfaces as a thrown service error.
const isNotModified = (error: unknown): boolean => {
  const { name, status } = errorShape(error);
  return status === 304 || name === 'NotModified';
};

/** A {@link SnapshotSource} that follows `<environment>/current.json` to the immutable snapshot it names. */
export function createS3SnapshotSource(options: S3SnapshotSourceOptions): SnapshotSource {
  const { bucket, environment } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError(`pollIntervalMs must be a positive number, got ${String(pollIntervalMs)}`);
  }
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  if (!Number.isFinite(reconcileIntervalMs) || reconcileIntervalMs < pollIntervalMs) {
    throw new RangeError(
      `reconcileIntervalMs must be a finite number no smaller than pollIntervalMs (${String(pollIntervalMs)}), got ${String(reconcileIntervalMs)}`,
    );
  }
  const client = options.client ?? new S3Client({});
  const logger = options.logger ?? consoleLogger;
  const pointerKey = `${environment}/current.json`;
  let loaded: LoadedSnapshot | undefined;

  const fetchText = (key: string, ifNoneMatch?: string): Promise<S3Text> =>
    readObjectText(client, bucket, key, ifNoneMatch);

  const toS3Error = (error: unknown, key: string, notFound: 'POINTER_NOT_FOUND' | 'SNAPSHOT_NOT_FOUND') =>
    new S3SnapshotError(isMissing(error) ? notFound : 'REQUEST_FAILED', key, error);

  const getObject = async (key: string, notFound: 'POINTER_NOT_FOUND' | 'SNAPSHOT_NOT_FOUND'): Promise<S3Text> => {
    try {
      return await fetchText(key);
    } catch (error) {
      throw toS3Error(error, key, notFound);
    }
  };

  const getPointerIfChanged = async (etag: string | undefined): Promise<S3Text | undefined> => {
    try {
      return await fetchText(pointerKey, etag);
    } catch (error) {
      if (isNotModified(error)) return undefined;
      throw toS3Error(error, pointerKey, 'POINTER_NOT_FOUND');
    }
  };

  const readPointer = (text: string | undefined): CurrentPointer => {
    const pointer = parseCurrentPointer(parseJsonObject(pointerKey, text));
    if (!pointer.ok) throw new S3SnapshotError('INVALID_POINTER', pointerKey, pointer.error);
    if (pointer.value.environment !== environment) {
      throw new S3SnapshotError(
        'INVALID_POINTER',
        pointerKey,
        new Error(`Pointer names environment ${pointer.value.environment}, expected ${environment}`),
      );
    }
    return pointer.value;
  };

  const loadVersion = async (pointerObject: S3Text, version: number): Promise<unknown> => {
    const snapshotKey = snapshotKeyFor(environment, version);
    const snapshot = parseJsonObject(snapshotKey, (await getObject(snapshotKey, 'SNAPSHOT_NOT_FOUND')).text);
    loaded = pointerObject.etag === undefined ? undefined : { etag: pointerObject.etag, version, snapshot };
    return snapshot;
  };

  const load = async (): Promise<unknown> => {
    const pointerObject = await getObject(pointerKey, 'POINTER_NOT_FOUND');
    if (loaded !== undefined && pointerObject.etag === loaded.etag) return loaded.snapshot;
    return loadVersion(pointerObject, readPointer(pointerObject.text).version);
  };

  const subscribe = (onChange: (snapshot: unknown) => void): Unsubscribe => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let lastReconciledAt = Date.now();
    // Push and poll loads run one at a time, so an older snapshot is never delivered after a newer one.
    let queue: Promise<void> = Promise.resolve();

    const serially = (job: () => Promise<void>): Promise<void> => {
      const run = queue.then(() => (stopped ? undefined : job()));
      queue = run.catch(() => undefined);
      return run;
    };

    const deliver = async (pointerObject: S3Text | undefined) => {
      if (pointerObject === undefined) return;
      const { version } = readPointer(pointerObject.text);
      if (loaded !== undefined && version === loaded.version) {
        if (pointerObject.etag !== undefined) loaded = { ...loaded, etag: pointerObject.etag };
        return;
      }
      const snapshot = await loadVersion(pointerObject, version);
      if (!stopped) onChange(snapshot);
    };

    const tick = async () => {
      const reconciling = Date.now() - lastReconciledAt >= reconcileIntervalMs;
      if (reconciling) lastReconciledAt = Date.now();
      await deliver(await getPointerIfChanged(reconciling ? undefined : loaded?.etag));
    };

    const push = async () => {
      await deliver(await getObject(pointerKey, 'POINTER_NOT_FOUND'));
    };

    const schedule = () => {
      timer = setTimeout(() => {
        void serially(tick)
          .catch((error: unknown) => {
            logger.error('Cannot poll the S3 snapshot pointer; keeping the active snapshot', error);
          })
          .finally(() => {
            if (!stopped) schedule();
          });
      }, pollIntervalMs);
    };

    const stopQueue = options.notificationQueue?.start((notification) =>
      notification.environment === environment ? serially(push) : Promise.resolve(),
    );
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stopQueue?.();
    };
  };

  return { load, subscribe };
}
