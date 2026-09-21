import { S3Client } from '@aws-sdk/client-s3';
import {
  parseSegmentPointer,
  segmentPointerKeyFor,
  validateSegmentKey,
  type SegmentPointer,
} from '../domain/segment-pointer.js';
import { validateEnvironmentName } from '../domain/publishing.js';
import { S3SegmentPublishError } from './s3-segment-publisher.js';
import { isNotFound, parseJsonObject, readObjectText } from './s3-read.js';

/** Options for {@link createS3SegmentVersionReader}. */
export interface S3SegmentVersionReaderOptions {
  readonly bucket: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

export interface S3SegmentVersionReader {
  /** Resolves to the version the Segment Pointer names, or `null` when the segment has never been published. */
  readVersion(environment: string, segmentKey: string): Promise<number | null>;
  /** Resolves to the whole Segment Pointer, or `null` when the segment has never been published. */
  readPointer(environment: string, segmentKey: string): Promise<SegmentPointer | null>;
}

/**
 * Reads `<environment>/segments/<key>/current.json` and nothing else — no version object, so no members are
 * fetched. Only a missing pointer is `null`; every other failure throws, so a caller never mistakes an S3
 * outage for "this segment does not exist yet".
 */
export function createS3SegmentVersionReader(options: S3SegmentVersionReaderOptions): S3SegmentVersionReader {
  const { bucket } = options;
  const client = options.client ?? new S3Client({});

  const readPointer = async (environment: string, segmentKey: string): Promise<SegmentPointer | null> => {
    const checkedEnvironment = validateEnvironmentName(environment);
    if (!checkedEnvironment.ok) {
      throw new S3SegmentPublishError('INVALID_ENVIRONMENT', environment, checkedEnvironment.error);
    }
    const checkedKey = validateSegmentKey(segmentKey);
    if (!checkedKey.ok) {
      throw new S3SegmentPublishError('INVALID_SEGMENT_KEY', `${environment}/segments`, checkedKey.error);
    }

    const key = segmentPointerKeyFor(checkedEnvironment.value, checkedKey.value);
    let text: string | undefined;
    try {
      ({ text } = await readObjectText(client, bucket, key));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new S3SegmentPublishError('REQUEST_FAILED', key, error);
    }

    let raw: unknown;
    try {
      raw = parseJsonObject(key, text);
    } catch (error) {
      throw new S3SegmentPublishError('INVALID_POINTER', key, error);
    }
    const pointer = parseSegmentPointer(raw);
    if (!pointer.ok) throw new S3SegmentPublishError('INVALID_POINTER', key, pointer.error);
    if (pointer.value.environment !== checkedEnvironment.value || pointer.value.segmentKey !== checkedKey.value) {
      throw new S3SegmentPublishError('INVALID_POINTER', key, new Error('Pointer names another environment or segment'));
    }
    return pointer.value;
  };

  return {
    readPointer,
    async readVersion(environment, segmentKey) {
      const pointer = await readPointer(environment, segmentKey);
      return pointer === null ? null : pointer.version;
    },
  };
}
