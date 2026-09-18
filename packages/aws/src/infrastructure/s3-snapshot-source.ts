import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Logger, SnapshotSource, Unsubscribe } from '@featuresync/core';
import { parseCurrentPointer, snapshotKeyFor, type CurrentPointer } from '../domain/current-pointer.js';
import { S3SnapshotError } from './s3-snapshot-error.js';

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
}

interface LoadedSnapshot {
  readonly etag: string;
  readonly version: number;
  readonly snapshot: unknown;
}

interface S3Text {
  readonly text: string | undefined;
  readonly etag: string | undefined;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 600_000;

const consoleLogger: Logger = {
  error: (message, error) => {
    console.error(`[featuresync] ${message}`, error);
  },
};

const errorShape = (error: unknown): { name?: unknown; status?: unknown } => {
  if (typeof error !== 'object' || error === null) return {};
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return { name, status: $metadata?.httpStatusCode };
};

// With GetObject-only permissions S3 answers 403 rather than 404 for a missing key.
const isMissing = (error: unknown): boolean => {
  const { name, status } = errorShape(error);
  return name === 'NoSuchKey' || name === 'AccessDenied' || status === 404 || status === 403;
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

  const fetchText = async (key: string, ifNoneMatch?: string): Promise<S3Text> => {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(ifNoneMatch === undefined ? {} : { IfNoneMatch: ifNoneMatch }),
    });
    const response = await client.send(command);
    return { text: await response.Body?.transformToString(), etag: response.ETag };
  };

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

  const parseJson = (key: string, text: string | undefined): unknown => {
    if (text === undefined || text === '') {
      throw new S3SnapshotError('INVALID_JSON', key, new Error('Object body is empty'));
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new S3SnapshotError('INVALID_JSON', key, error);
    }
  };

  const readPointer = (text: string | undefined): CurrentPointer => {
    const pointer = parseCurrentPointer(parseJson(pointerKey, text));
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
    const snapshot = parseJson(snapshotKey, (await getObject(snapshotKey, 'SNAPSHOT_NOT_FOUND')).text);
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

    const tick = async () => {
      const reconciling = Date.now() - lastReconciledAt >= reconcileIntervalMs;
      if (reconciling) lastReconciledAt = Date.now();
      const pointerObject = await getPointerIfChanged(reconciling ? undefined : loaded?.etag);
      if (pointerObject === undefined) return;
      const { version } = readPointer(pointerObject.text);
      if (loaded !== undefined && version === loaded.version) {
        if (pointerObject.etag !== undefined) loaded = { ...loaded, etag: pointerObject.etag };
        return;
      }
      const snapshot = await loadVersion(pointerObject, version);
      if (!stopped) onChange(snapshot);
    };

    const schedule = () => {
      timer = setTimeout(() => {
        void tick()
          .catch((error: unknown) => {
            logger.error('Cannot poll the S3 snapshot pointer; keeping the active snapshot', error);
          })
          .finally(() => {
            if (!stopped) schedule();
          });
      }, pollIntervalMs);
    };

    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  };

  return { load, subscribe };
}
