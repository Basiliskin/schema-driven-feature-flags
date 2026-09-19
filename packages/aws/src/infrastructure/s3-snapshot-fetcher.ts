import { S3Client } from '@aws-sdk/client-s3';
import { environmentSchema, snapshotKeyFor, versionSchema } from '../domain/current-pointer.js';
import { isAccessDenied, isNotFound, readObjectText } from './s3-read.js';

/** Why a pinned snapshot could not be fetched. */
export type S3FetchErrorReason =
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_VERSION'
  | 'SNAPSHOT_NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'EMPTY_SNAPSHOT'
  | 'REQUEST_FAILED';

/** A fetch failed. `cause` holds the underlying S3 or validation error. */
export class S3FetchError extends Error {
  override readonly name = 'S3FetchError';

  constructor(
    readonly reason: S3FetchErrorReason,
    readonly key: string,
    cause: unknown,
  ) {
    super(`${reason} for s3 object ${key}`, { cause });
  }
}

/** Options for {@link createS3SnapshotFetcher}. */
export interface S3SnapshotFetcherOptions {
  readonly bucket: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

/** The raw, unvalidated bytes of one published snapshot version. */
export interface FetchedSnapshot {
  readonly environment: string;
  readonly version: number;
  readonly key: string;
  readonly text: string;
}

export interface S3SnapshotFetcher {
  fetch(environment: string, version: number): Promise<FetchedSnapshot>;
}

const failureReason = (error: unknown): S3FetchErrorReason => {
  if (isNotFound(error)) return 'SNAPSHOT_NOT_FOUND';
  if (isAccessDenied(error)) return 'ACCESS_DENIED';
  return 'REQUEST_FAILED';
};

/** Reads `<environment>/snapshots/<version>.json` as-is, without consulting the current pointer. */
export function createS3SnapshotFetcher(options: S3SnapshotFetcherOptions): S3SnapshotFetcher {
  const { bucket } = options;
  const client = options.client ?? new S3Client({});

  return {
    async fetch(environment, version) {
      const checkedEnvironment = environmentSchema.safeParse(environment);
      if (!checkedEnvironment.success) {
        throw new S3FetchError('INVALID_ENVIRONMENT', environment, checkedEnvironment.error);
      }
      const checkedVersion = versionSchema.safeParse(version);
      if (!checkedVersion.success) {
        throw new S3FetchError('INVALID_VERSION', String(version), checkedVersion.error);
      }

      const key = snapshotKeyFor(checkedEnvironment.data, checkedVersion.data);
      let text: string | undefined;
      try {
        ({ text } = await readObjectText(client, bucket, key));
      } catch (error) {
        throw new S3FetchError(failureReason(error), key, error);
      }
      if (text === undefined || text === '') throw new S3FetchError('EMPTY_SNAPSHOT', key, undefined);

      return { environment: checkedEnvironment.data, version: checkedVersion.data, key, text };
    },
  };
}
