import { S3Client } from '@aws-sdk/client-s3';
import {
  parseSnapshot,
  referencedSegmentKeys,
  type Logger,
  type SnapshotBundle,
  type SnapshotSource,
  type Unsubscribe,
} from '@featuresync/core';
import { parseCurrentPointer, snapshotKeyFor, type CurrentPointer } from '../domain/current-pointer.js';
import { parseSegmentPointer, segmentObjectKeyFor, segmentPointerKeyFor } from '../domain/segment-pointer.js';
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
  /** Keys of the segments the snapshot references; `undefined` when it is delivered bare. */
  readonly segmentKeys: readonly string[] | undefined;
  /** The raw snapshot, or a {@link SnapshotBundle} when it references segments. */
  readonly payload: unknown;
}

interface LoadedSegment {
  readonly etag: string | undefined;
  readonly version: number;
  readonly segment: unknown;
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

/**
 * A {@link SnapshotSource} that follows `<environment>/current.json` to the immutable snapshot it names.
 * Segments the snapshot references are read through their own Segment Pointer
 * and delivered with it as a {@link SnapshotBundle}; a segment that cannot be read is left out.
 */
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
  const segments = new Map<string, LoadedSegment>();

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

  // Segment objects hold personal data, so a failure is reported by key only, never with its cause.
  // A segment that fails keeps its last loaded copy and is read again on the next check.
  const refreshSegment = async (key: string, conditional: boolean): Promise<boolean> => {
    const cached = segments.get(key);
    const segmentPointerKey = segmentPointerKeyFor(environment, key);
    try {
      const pointerObject = await fetchText(segmentPointerKey, conditional ? cached?.etag : undefined);
      const pointer = parseSegmentPointer(parseJsonObject(segmentPointerKey, pointerObject.text));
      if (!pointer.ok || pointer.value.environment !== environment || pointer.value.segmentKey !== key) {
        throw new Error('Invalid segment pointer');
      }
      const { version } = pointer.value;
      if (cached?.version === version) {
        segments.set(key, { ...cached, etag: pointerObject.etag });
        return false;
      }
      const objectKey = segmentObjectKeyFor(environment, key, version);
      const segment = parseJsonObject(objectKey, (await fetchText(objectKey)).text);
      segments.set(key, { etag: pointerObject.etag, version, segment });
      return true;
    } catch (error) {
      if (isNotModified(error)) return false;
      logger.error('Ignoring unloadable segment; its conditions will not match', new Error(`Segment "${key}"`));
      return false;
    }
  };

  const refreshSegments = async (keys: readonly string[], conditional: boolean): Promise<boolean> => {
    const changed = await Promise.all(keys.map((key) => refreshSegment(key, conditional)));
    for (const key of segments.keys()) if (!keys.includes(key)) segments.delete(key);
    return changed.includes(true);
  };

  const segmentKeysOf = (snapshot: unknown): readonly string[] | undefined => {
    const parsed = parseSnapshot(snapshot);
    if (!parsed.ok) return undefined;
    const keys = [...referencedSegmentKeys(parsed.value)];
    return keys.length === 0 ? undefined : keys;
  };

  const payloadOf = (snapshot: unknown, keys: readonly string[] | undefined): unknown =>
    keys === undefined
      ? snapshot
      : ({
          snapshot,
          segments: keys.flatMap((key) => {
            const loadedSegment = segments.get(key);
            return loadedSegment === undefined ? [] : [loadedSegment.segment];
          }),
        } satisfies SnapshotBundle);

  const loadVersion = async (pointerObject: S3Text, version: number, conditional: boolean): Promise<unknown> => {
    const snapshotKey = snapshotKeyFor(environment, version);
    const snapshot = parseJsonObject(snapshotKey, (await getObject(snapshotKey, 'SNAPSHOT_NOT_FOUND')).text);
    const segmentKeys = segmentKeysOf(snapshot);
    await refreshSegments(segmentKeys ?? [], conditional);
    const payload = payloadOf(snapshot, segmentKeys);
    loaded =
      pointerObject.etag === undefined
        ? undefined
        : { etag: pointerObject.etag, version, snapshot, segmentKeys, payload };
    return payload;
  };

  const load = async (): Promise<unknown> => {
    const pointerObject = await getObject(pointerKey, 'POINTER_NOT_FOUND');
    if (loaded !== undefined && pointerObject.etag === loaded.etag) return loaded.payload;
    return loadVersion(pointerObject, readPointer(pointerObject.text).version, true);
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

    const emit = (payload: unknown) => {
      if (!stopped) onChange(payload);
    };

    // A snapshot pointer check is always followed by a segment pointer check, because segment
    // uploads send no Change Notification; either change yields exactly one delivery.
    const deliver = async (pointerObject: S3Text | undefined, conditional: boolean) => {
      if (pointerObject !== undefined) {
        const { version } = readPointer(pointerObject.text);
        if (loaded?.version !== version) {
          emit(await loadVersion(pointerObject, version, conditional));
          return;
        }
        if (pointerObject.etag !== undefined) loaded = { ...loaded, etag: pointerObject.etag };
      }
      const current = loaded;
      if (current?.segmentKeys === undefined) return;
      if (!(await refreshSegments(current.segmentKeys, conditional))) return;
      loaded = { ...current, payload: payloadOf(current.snapshot, current.segmentKeys) };
      emit(loaded.payload);
    };

    const tick = async () => {
      const reconciling = Date.now() - lastReconciledAt >= reconcileIntervalMs;
      if (reconciling) lastReconciledAt = Date.now();
      await deliver(await getPointerIfChanged(reconciling ? undefined : loaded?.etag), !reconciling);
    };

    const push = async () => {
      await deliver(await getObject(pointerKey, 'POINTER_NOT_FOUND'), false);
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
