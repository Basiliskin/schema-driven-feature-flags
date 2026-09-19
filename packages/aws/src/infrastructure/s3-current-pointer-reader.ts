import { S3Client } from '@aws-sdk/client-s3';
import { environmentSchema, parseCurrentPointer } from '../domain/current-pointer.js';
import { S3FetchError } from './s3-snapshot-fetcher.js';
import { S3SnapshotError } from './s3-snapshot-error.js';
import { isAccessDenied, isNotFound, parseJsonObject, readObjectText } from './s3-read.js';

/** Options for {@link createS3CurrentPointerReader}. */
export interface S3CurrentPointerReaderOptions {
  readonly bucket: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

export interface S3CurrentPointerReader {
  /** Resolves to the version `<environment>/current.json` names, or `undefined` when nothing was published yet. */
  read(environment: string): Promise<number | undefined>;
}

/** Reads `<environment>/current.json` once, without subscribing to changes. */
export function createS3CurrentPointerReader(options: S3CurrentPointerReaderOptions): S3CurrentPointerReader {
  const { bucket } = options;
  const client = options.client ?? new S3Client({});

  return {
    async read(environment) {
      const checkedEnvironment = environmentSchema.safeParse(environment);
      if (!checkedEnvironment.success) {
        throw new S3FetchError('INVALID_ENVIRONMENT', environment, checkedEnvironment.error);
      }

      const key = `${checkedEnvironment.data}/current.json`;
      let text: string | undefined;
      try {
        ({ text } = await readObjectText(client, bucket, key));
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw new S3FetchError(isAccessDenied(error) ? 'ACCESS_DENIED' : 'REQUEST_FAILED', key, error);
      }

      const pointer = parseCurrentPointer(parseJsonObject(key, text));
      if (!pointer.ok) throw new S3SnapshotError('INVALID_POINTER', key, pointer.error);
      if (pointer.value.environment !== checkedEnvironment.data) {
        throw new S3SnapshotError(
          'INVALID_POINTER',
          key,
          new Error(`Pointer names environment ${pointer.value.environment}, expected ${checkedEnvironment.data}`),
        );
      }
      return pointer.value.version;
    },
  };
}
