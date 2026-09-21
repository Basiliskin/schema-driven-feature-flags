import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { validateEnvironmentName } from '../domain/publishing.js';
import { validateSegmentKey } from '../domain/segment-pointer.js';
import { S3SegmentPublishError } from './s3-segment-publisher.js';

/** Options for {@link createS3SegmentLister}. */
export interface S3SegmentListerOptions {
  readonly bucket: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

export interface S3SegmentLister {
  /** Resolves to the Segment Keys published in the environment, sorted; an unlisted prefix is an empty list. */
  listSegmentKeys(environment: string): Promise<readonly string[]>;
}

const segmentsPrefixFor = (environment: string): string => `${environment}/segments/`;

const keyFromCommonPrefix = (commonPrefix: string, prefix: string): string | undefined => {
  if (!commonPrefix.startsWith(prefix) || !commonPrefix.endsWith('/')) return undefined;
  const key = commonPrefix.slice(prefix.length, -1);
  return validateSegmentKey(key).ok ? key : undefined;
};

/**
 * Enumerates the segments of one environment from the `<environment>/segments/` prefix itself, so no index
 * object has to be written and repaired on every publish. `Delimiter` keeps the response to one entry per
 * segment rather than one per member file.
 */
export function createS3SegmentLister(options: S3SegmentListerOptions): S3SegmentLister {
  const { bucket } = options;
  const client = options.client ?? new S3Client({});

  return {
    async listSegmentKeys(environment) {
      const checkedEnvironment = validateEnvironmentName(environment);
      if (!checkedEnvironment.ok) {
        throw new S3SegmentPublishError('INVALID_ENVIRONMENT', environment, checkedEnvironment.error);
      }

      const prefix = segmentsPrefixFor(checkedEnvironment.value);
      const listPage = async (continuationToken: string | undefined) => {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        });
        try {
          return await client.send(command);
        } catch (error) {
          throw new S3SegmentPublishError('REQUEST_FAILED', prefix, error);
        }
      };

      const keys = new Set<string>();
      let continuationToken: string | undefined;
      do {
        const response = await listPage(continuationToken);
        for (const { Prefix } of response.CommonPrefixes ?? []) {
          const key = Prefix === undefined ? undefined : keyFromCommonPrefix(Prefix, prefix);
          if (key !== undefined) keys.add(key);
        }
        continuationToken = response.IsTruncated === true ? response.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);

      return [...keys].sort((left, right) => left.localeCompare(right));
    },
  };
}
