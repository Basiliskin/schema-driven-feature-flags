import type { S3Client } from '@aws-sdk/client-s3';
import {
  createS3CurrentPointerReader,
  createS3SegmentLister,
  createS3SegmentPublisher,
  createS3SegmentVersionReader,
  createS3SnapshotFetcher,
  createS3SnapshotPublisher,
  type SegmentPointer,
  type SnapshotValidation,
} from '@featuresync/aws';
import { parseSnapshot } from '@featuresync/core';
import type {
  PublishedSegment,
  PublishedSegmentListing,
  PublishedSegmentsPort,
} from '../application/list-published-segments.js';
import type { SegmentUploadPorts } from '../application/upload-segment.js';
import type { DashboardPorts } from './http-server.js';

export interface AwsDashboardConfig {
  readonly bucket: string;
  readonly topicArn?: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

const toPublishedSegment = (pointer: SegmentPointer): PublishedSegment => ({
  segmentKey: pointer.segmentKey,
  version: pointer.version,
  ...(pointer.memberAttribute === undefined ? {} : { memberAttribute: pointer.memberAttribute }),
});

const validateSnapshot = (raw: unknown): SnapshotValidation => {
  const parsed = parseSnapshot(raw);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
};

export function createAwsDashboardPorts(
  config: AwsDashboardConfig,
): DashboardPorts & SegmentUploadPorts & PublishedSegmentsPort {
  const { bucket, topicArn } = config;
  const s3 = config.client === undefined ? { bucket } : { bucket, client: config.client };
  const reader = createS3CurrentPointerReader(s3);
  const fetcher = createS3SnapshotFetcher(s3);
  const segmentPublisher = createS3SegmentPublisher(s3);
  const segmentVersionReader = createS3SegmentVersionReader(s3);
  const segmentLister = createS3SegmentLister(s3);

  // A key the listing holds but whose pointer is gone was never published, so it is left out rather than
  // failing the listing; anything else unreadable makes the whole catalogue untrustworthy, hence unavailable.
  const listPublishedSegments = async (environment: string): Promise<PublishedSegmentListing> => {
    try {
      const keys = await segmentLister.listSegmentKeys(environment);
      const pointers = await Promise.all(keys.map((key) => segmentVersionReader.readPointer(environment, key)));
      const segments = pointers.flatMap((pointer) => (pointer === null ? [] : [toPublishedSegment(pointer)]));
      return { status: 'listed', segments };
    } catch {
      return { status: 'unavailable' };
    }
  };

  return {
    listPublishedSegments,
    readCurrentVersion: (environment) => reader.read(environment),
    fetchSnapshotText: async (environment, version) => (await fetcher.fetch(environment, version)).text,
    publishSegment: (environment, upload) =>
      segmentPublisher.publish(
        environment,
        { key: upload.key, memberAttribute: upload.memberAttribute, members: upload.members },
        { expectedCurrentVersion: upload.expectedCurrentVersion },
      ),
    readSegmentVersion: (environment, key) => segmentVersionReader.readVersion(environment, key),
    openWriter: (onNotifyError) =>
      createS3SnapshotPublisher({
        ...s3,
        validate: validateSnapshot,
        onNotifyError,
        ...(topicArn === undefined ? {} : { topicArn }),
      }),
  };
}
