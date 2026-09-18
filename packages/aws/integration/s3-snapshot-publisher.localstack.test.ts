import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { parseSnapshot } from '@featuresync/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createS3SnapshotPublisher, S3PublishError } from '../src/infrastructure/s3-snapshot-publisher.js';
import { createS3SnapshotSource } from '../src/infrastructure/s3-snapshot-source.js';

const ENVIRONMENT = 'integration';

// Guards against running this suite against real AWS when the local endpoint is not configured.
if (process.env.AWS_ENDPOINT_URL_S3 === undefined) {
  throw new Error('AWS_ENDPOINT_URL_S3 must be set; see .env.example');
}

const s3 = new S3Client({});

const snapshot = (reason: string) => ({
  schemaVersion: 1,
  environment: ENVIRONMENT,
  version: 1,
  createdAt: '2026-09-18T06:00:00.000Z',
  createdBy: 'integration',
  previousVersion: null,
  reason,
  features: { 'new-dashboard': { type: 'boolean', enabled: true } },
});

const listKeys = async (bucket: string) => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return Contents.map(({ Key }) => Key);
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
describe('createS3SnapshotPublisher against LocalStack', () => {
  let bucket: string;

  const publisher = () => createS3SnapshotPublisher({ bucket, validate: parseSnapshot });
  const load = () => createS3SnapshotSource({ bucket, environment: ENVIRONMENT }).load();

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

  it('rejects a repeated IfNoneMatch put and a stale IfMatch put with 412 PreconditionFailed', async () => {
    const key = 'probe.json';
    const put = (condition: { IfNoneMatch: '*' } | { IfMatch: string }, body: string) =>
      s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ...condition }));
    const preconditionFailed = { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };

    const { ETag: staleEtag } = await put({ IfNoneMatch: '*' }, 'first');
    expect(await rejection(put({ IfNoneMatch: '*' }, 'again'))).toMatchObject(preconditionFailed);

    if (staleEtag === undefined) throw new Error('expected an ETag');
    await put({ IfMatch: staleEtag }, 'second');
    expect(await rejection(put({ IfMatch: staleEtag }, 'stale'))).toMatchObject(preconditionFailed);
  });

  it('publishes v1 and v2 and rolls back to v1, each readable by the snapshot source', async () => {
    const target = publisher();

    await expect(target.publish(ENVIRONMENT, snapshot('first'))).resolves.toBe(1);
    await expect(load()).resolves.toMatchObject({ reason: 'first' });

    await expect(target.publish(ENVIRONMENT, snapshot('second'))).resolves.toBe(2);
    await expect(load()).resolves.toMatchObject({ reason: 'second' });

    await expect(target.rollback(ENVIRONMENT, 1)).resolves.toBe(1);
    await expect(load()).resolves.toMatchObject({ reason: 'first' });
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${ENVIRONMENT}/snapshots/2.json` })),
    ).resolves.toBeDefined();
  });

  it('lets exactly one of two concurrent publishes win', async () => {
    const outcomes = await Promise.allSettled([
      publisher().publish(ENVIRONMENT, snapshot('left')),
      publisher().publish(ENVIRONMENT, snapshot('right')),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(S3PublishError);
    expect(['CONFLICT', 'VERSION_EXISTS']).toContain((rejected[0] as S3PublishError).reason);
    await expect(load()).resolves.toBeDefined();
  });

  it('writes nothing when the snapshot is invalid', async () => {
    const error = await rejection(publisher().publish(ENVIRONMENT, { ...snapshot('bad'), features: 'none' }));

    expect(error).toMatchObject({ name: 'S3PublishError', reason: 'INVALID_SNAPSHOT' });
    await expect(listKeys(bucket)).resolves.toEqual([]);
  });
});
