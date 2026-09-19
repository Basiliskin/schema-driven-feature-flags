import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { parseSnapshot } from '@featuresync/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createS3CurrentPointerReader } from '../src/infrastructure/s3-current-pointer-reader.js';
import { createS3SnapshotPublisher } from '../src/infrastructure/s3-snapshot-publisher.js';

const ENVIRONMENT = 'integration';

// Guards against running this suite against real AWS when the local endpoint is not configured.
if (process.env.AWS_ENDPOINT_URL_S3 === undefined) {
  throw new Error('AWS_ENDPOINT_URL_S3 must be set; see .env.example');
}

const s3 = new S3Client({});

const snapshot = (reason: string, enabled: boolean) => ({
  schemaVersion: 1,
  environment: ENVIRONMENT,
  version: 1,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'integration',
  previousVersion: null,
  reason,
  features: { 'new-dashboard': { type: 'boolean', enabled } },
});

const listKeys = async (bucket: string) => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return Contents.map(({ Key }) => Key);
};

// Pinned by docker/docker-compose.yml to localstack/localstack:2026.08.3.
describe('createS3CurrentPointerReader against LocalStack', () => {
  let bucket: string;

  const reader = () => createS3CurrentPointerReader({ bucket });

  beforeEach(async () => {
    bucket = `featuresync-it-${randomUUID()}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterEach(async () => {
    const keys = await listKeys(bucket);
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  });

  afterAll(() => {
    s3.destroy();
  });

  it('resolves to undefined for an environment with no published snapshot', async () => {
    await expect(reader().read(ENVIRONMENT)).resolves.toBeUndefined();
  });

  it('follows the current pointer through publishes and a rollback, which adds a version', async () => {
    const publisher = createS3SnapshotPublisher({ bucket, validate: parseSnapshot });

    await publisher.publish(ENVIRONMENT, snapshot('first', true));
    await expect(reader().read(ENVIRONMENT)).resolves.toBe(1);

    await publisher.publish(ENVIRONMENT, snapshot('second', false));
    await expect(reader().read(ENVIRONMENT)).resolves.toBe(2);

    await publisher.rollback(ENVIRONMENT, 1);
    await expect(reader().read(ENVIRONMENT)).resolves.toBe(3);
  });
});
