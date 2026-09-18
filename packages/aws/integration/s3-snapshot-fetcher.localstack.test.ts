import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { parseSnapshot } from '@featuresync/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createS3SnapshotFetcher, S3FetchError } from '../src/infrastructure/s3-snapshot-fetcher.js';
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
  createdAt: '2026-09-18T06:00:00.000Z',
  createdBy: 'integration',
  previousVersion: null,
  reason,
  features: { 'new-dashboard': { type: 'boolean', enabled } },
});

const listKeys = async (bucket: string) => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return Contents.map(({ Key }) => Key);
};

const storedText = async (bucket: string, key: string) => {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Body?.transformToString();
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

// Pinned by docker/docker-compose.yml to localstack/localstack:2026.08.3.
describe('createS3SnapshotFetcher against LocalStack', () => {
  let bucket: string;

  const fetcher = () => createS3SnapshotFetcher({ bucket });

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

  it('fetches a pinned version byte-for-byte after a newer version became current', async () => {
    const publisher = createS3SnapshotPublisher({ bucket, validate: parseSnapshot });
    await expect(publisher.publish(ENVIRONMENT, snapshot('first', true))).resolves.toBe(1);
    await expect(publisher.publish(ENVIRONMENT, snapshot('second', false))).resolves.toBe(2);
    const publishedV1 = await storedText(bucket, `${ENVIRONMENT}/snapshots/1.json`);
    const publishedV2 = await storedText(bucket, `${ENVIRONMENT}/snapshots/2.json`);
    expect(publishedV1).not.toBe(publishedV2);

    const fetched = await fetcher().fetch(ENVIRONMENT, 1);

    expect(fetched.text).toBe(publishedV1);
    expect(fetched.version).toBe(1);
    expect(fetched.environment).toBe(ENVIRONMENT);
    expect(fetched.key.endsWith('/snapshots/1.json')).toBe(true);
  });

  it('reports a version that was never published as SNAPSHOT_NOT_FOUND', async () => {
    const error = await rejection(fetcher().fetch(ENVIRONMENT, 99));

    expect(error).toBeInstanceOf(S3FetchError);
    expect((error as S3FetchError).reason).toBe('SNAPSHOT_NOT_FOUND');
  });
});
