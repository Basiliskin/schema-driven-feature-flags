import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SEGMENT_SCHEMA_VERSION, parseSegment, type Segment } from '@featuresync/core';
import { validateEnvironmentName, type PublishingError } from '../domain/publishing.js';
import {
  buildSegmentPointer,
  nextSegmentVersion,
  parseSegmentPointer,
  segmentPointerKeyFor,
  validateSegmentKey,
  type InvalidSegmentKey,
  type SegmentPointer,
} from '../domain/segment-pointer.js';
import { isPreconditionFailed } from './s3-errors.js';
import { isNotFound, readObjectText } from './s3-read.js';

/** Why a segment upload wrote nothing, or stopped before moving the Segment Pointer. */
export type S3SegmentPublishErrorReason =
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_SEGMENT_KEY'
  | 'INVALID_SEGMENT'
  | 'INVALID_POINTER'
  | 'VERSION_EXISTS'
  | 'CONFLICT'
  | 'REQUEST_FAILED';

/** A segment upload failed. `cause` holds the underlying S3 or validation error, which never carries a member. */
export class S3SegmentPublishError extends Error {
  override readonly name = 'S3SegmentPublishError';

  constructor(
    readonly reason: S3SegmentPublishErrorReason,
    readonly key: string,
    cause: unknown,
  ) {
    super(`${reason} for s3 object ${key}`, { cause });
  }
}

/** The members to upload. The publisher assigns `version` and `schemaVersion`. */
export type SegmentDraft = Pick<Segment, 'key' | 'memberAttribute' | 'members'>;

export interface S3SegmentPublisherOptions {
  readonly bucket: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

export interface S3SegmentPublisher {
  /** Writes the segment as its next version and makes it current. Resolves to the new Segment Pointer. */
  publish(environment: string, segment: SegmentDraft): Promise<SegmentPointer>;
}

interface ReadPointer {
  readonly pointer: SegmentPointer;
  readonly etag: string;
}

type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PublishingError | InvalidSegmentKey };

const valid = <T>(result: Checked<T>, key: string): T => {
  if (result.ok) return result.value;
  const reason = result.error.reason === 'INVALID_SEGMENT_KEY' ? 'INVALID_SEGMENT_KEY' : 'INVALID_ENVIRONMENT';
  throw new S3SegmentPublishError(reason, key, result.error);
};

/**
 * Writes `<environment>/segments/<key>/<n>.json` and moves `<environment>/segments/<key>/current.json` with S3
 * conditional writes. Sends no Change Notification: SDKs pick segment changes up by polling.
 */
export function createS3SegmentPublisher(options: S3SegmentPublisherOptions): S3SegmentPublisher {
  const { bucket } = options;
  const client = options.client ?? new S3Client({});

  const readPointer = async (environment: string, segmentKey: string): Promise<ReadPointer | undefined> => {
    const key = segmentPointerKeyFor(environment, segmentKey);
    let object: Awaited<ReturnType<typeof readObjectText>>;
    try {
      object = await readObjectText(client, bucket, key);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new S3SegmentPublishError('REQUEST_FAILED', key, error);
    }
    if (object.etag === undefined) {
      throw new S3SegmentPublishError('REQUEST_FAILED', key, new Error('Pointer response carries no ETag'));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(object.text ?? '');
    } catch (error) {
      throw new S3SegmentPublishError('INVALID_POINTER', key, error);
    }
    const pointer = parseSegmentPointer(raw);
    if (!pointer.ok) throw new S3SegmentPublishError('INVALID_POINTER', key, pointer.error);
    if (pointer.value.environment !== environment || pointer.value.segmentKey !== segmentKey) {
      throw new S3SegmentPublishError('INVALID_POINTER', key, new Error('Pointer names another environment or segment'));
    }
    return { pointer: pointer.value, etag: object.etag };
  };

  const put = async (
    key: string,
    body: unknown,
    condition: { IfMatch: string } | { IfNoneMatch: '*' },
    onPreconditionFailed: 'VERSION_EXISTS' | 'CONFLICT',
  ): Promise<void> => {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(body),
          ContentType: 'application/json',
          ...condition,
        }),
      );
    } catch (error) {
      throw new S3SegmentPublishError(isPreconditionFailed(error) ? onPreconditionFailed : 'REQUEST_FAILED', key, error);
    }
  };

  const publish = async (environment: string, segment: SegmentDraft): Promise<SegmentPointer> => {
    const env = valid(validateEnvironmentName(environment), environment);
    const segmentKey = valid(validateSegmentKey(segment.key), `${env}/segments`);
    const current = await readPointer(env, segmentKey);
    const pointer = valid(buildSegmentPointer(env, segmentKey, nextSegmentVersion(current?.pointer)), env);
    const stored = parseSegment({
      schemaVersion: SEGMENT_SCHEMA_VERSION,
      key: segmentKey,
      version: pointer.version,
      memberAttribute: segment.memberAttribute,
      members: segment.members,
    });
    if (!stored.ok) throw new S3SegmentPublishError('INVALID_SEGMENT', pointer.objectKey, stored.error);
    await put(pointer.objectKey, stored.value, { IfNoneMatch: '*' }, 'VERSION_EXISTS');
    await put(
      segmentPointerKeyFor(env, segmentKey),
      pointer,
      current === undefined ? { IfNoneMatch: '*' } : { IfMatch: current.etag },
      'CONFLICT',
    );
    return pointer;
  };

  return { publish };
}
