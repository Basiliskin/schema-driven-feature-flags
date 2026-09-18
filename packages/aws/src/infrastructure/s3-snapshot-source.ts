import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SnapshotSource } from '@featuresync/core';
import { parseCurrentPointer, snapshotKeyFor } from '../domain/current-pointer.js';
import { S3SnapshotError } from './s3-snapshot-error.js';

/** Options for {@link createS3SnapshotSource}. */
export interface S3SnapshotSourceOptions {
  readonly bucket: string;
  readonly environment: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

interface LoadedSnapshot {
  readonly etag: string;
  readonly version: number;
  readonly snapshot: unknown;
}

// With GetObject-only permissions S3 answers 403 rather than 404 for a missing key.
const isMissing = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const status = $metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'AccessDenied' || status === 404 || status === 403;
};

/** A {@link SnapshotSource} that follows `<environment>/current.json` to the immutable snapshot it names. */
export function createS3SnapshotSource(options: S3SnapshotSourceOptions): SnapshotSource {
  const { bucket, environment } = options;
  const client = options.client ?? new S3Client({});
  let loaded: LoadedSnapshot | undefined;

  const getObject = async (key: string, notFound: 'POINTER_NOT_FOUND' | 'SNAPSHOT_NOT_FOUND') => {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const text = await response.Body?.transformToString();
      return { text, etag: response.ETag };
    } catch (error) {
      throw new S3SnapshotError(isMissing(error) ? notFound : 'REQUEST_FAILED', key, error);
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

  const load = async (): Promise<unknown> => {
    const pointerKey = `${environment}/current.json`;
    const pointerObject = await getObject(pointerKey, 'POINTER_NOT_FOUND');
    if (loaded !== undefined && pointerObject.etag === loaded.etag) return loaded.snapshot;

    const pointer = parseCurrentPointer(parseJson(pointerKey, pointerObject.text));
    if (!pointer.ok) throw new S3SnapshotError('INVALID_POINTER', pointerKey, pointer.error);
    if (pointer.value.environment !== environment) {
      throw new S3SnapshotError(
        'INVALID_POINTER',
        pointerKey,
        new Error(`Pointer names environment ${pointer.value.environment}, expected ${environment}`),
      );
    }

    const snapshotKey = snapshotKeyFor(environment, pointer.value.version);
    const snapshotObject = await getObject(snapshotKey, 'SNAPSHOT_NOT_FOUND');
    const snapshot = parseJson(snapshotKey, snapshotObject.text);
    loaded =
      pointerObject.etag === undefined
        ? undefined
        : {
            etag: pointerObject.etag,
            version: pointer.value.version,
            snapshot,
          };
    return snapshot;
  };

  return { load };
}
