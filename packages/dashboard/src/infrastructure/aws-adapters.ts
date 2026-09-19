import type { S3Client } from '@aws-sdk/client-s3';
import {
  createS3CurrentPointerReader,
  createS3SnapshotFetcher,
  createS3SnapshotPublisher,
  type SnapshotValidation,
} from '@featuresync/aws';
import { parseSnapshot } from '@featuresync/core';
import type { DashboardPorts } from './http-server.js';

export interface AwsDashboardConfig {
  readonly bucket: string;
  readonly topicArn?: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
}

const validateSnapshot = (raw: unknown): SnapshotValidation => {
  const parsed = parseSnapshot(raw);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
};

export function createAwsDashboardPorts(config: AwsDashboardConfig): DashboardPorts {
  const { bucket, topicArn } = config;
  const s3 = config.client === undefined ? { bucket } : { bucket, client: config.client };
  const reader = createS3CurrentPointerReader(s3);
  const fetcher = createS3SnapshotFetcher(s3);
  return {
    now: () => new Date(),
    readCurrentVersion: (environment) => reader.read(environment),
    fetchSnapshotText: async (environment, version) => (await fetcher.fetch(environment, version)).text,
    openWriter: (onNotifyError) =>
      createS3SnapshotPublisher({
        ...s3,
        validate: validateSnapshot,
        onNotifyError,
        ...(topicArn === undefined ? {} : { topicArn }),
      }),
  };
}
