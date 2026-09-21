export { S3SnapshotError, type S3SnapshotErrorReason } from './infrastructure/s3-snapshot-error.js';
export { createS3SnapshotSource, type S3SnapshotSourceOptions } from './infrastructure/s3-snapshot-source.js';
export {
  createS3SnapshotPublisher,
  S3PublishError,
  type PublishOptions,
  type RollbackOptions,
  type NotifyErrorHandler,
  type NotifyFailure,
  type S3PublishErrorReason,
  type S3SnapshotPublisher,
  type S3SnapshotPublisherOptions,
  type SnapshotValidation,
} from './infrastructure/s3-snapshot-publisher.js';
export {
  createS3SegmentPublisher,
  S3SegmentPublishError,
  type S3SegmentPublishErrorReason,
  type S3SegmentPublisher,
  type S3SegmentPublisherOptions,
  type SegmentDraft,
  type SegmentPublishOptions,
} from './infrastructure/s3-segment-publisher.js';
export {
  createS3SegmentLister,
  type S3SegmentLister,
  type S3SegmentListerOptions,
} from './infrastructure/s3-segment-lister.js';
export {
  createS3SegmentVersionReader,
  type S3SegmentVersionReader,
  type S3SegmentVersionReaderOptions,
} from './infrastructure/s3-segment-version-reader.js';
export { parseSegmentPointer, type SegmentPointer, type SegmentPointerResult } from './domain/segment-pointer.js';
export {
  parseSegmentCsv,
  type SegmentCsvError,
  type SegmentCsvErrorReason,
  type SegmentCsvTarget,
} from './domain/segment-csv.js';
export {
  createS3SnapshotFetcher,
  S3FetchError,
  type FetchedSnapshot,
  type S3FetchErrorReason,
  type S3SnapshotFetcherOptions,
} from './infrastructure/s3-snapshot-fetcher.js';
export {
  createS3CurrentPointerReader,
  type S3CurrentPointerReader,
  type S3CurrentPointerReaderOptions,
} from './infrastructure/s3-current-pointer-reader.js';
export {
  createSqsNotificationQueue,
  type NotificationHandler,
  type NotificationQueue,
  type SqsNotificationQueueOptions,
} from './infrastructure/sqs-notification-queue.js';
export type { ChangeNotification } from './domain/change-notification.js';
