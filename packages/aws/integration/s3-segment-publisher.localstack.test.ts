import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { parseSegment } from '@featuresync/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSegmentPointer } from '../src/domain/segment-pointer.js';
import { createS3SegmentPublisher, S3SegmentPublishError } from '../src/infrastructure/s3-segment-publisher.js';

const ENVIRONMENT = 'integration';
const POINTER_KEY = `${ENVIRONMENT}/segments/beta/current.json`;

// Guards against running this suite against real AWS when the local endpoint is not configured.
if (process.env.AWS_ENDPOINT_URL_S3 === undefined) {
  throw new Error('AWS_ENDPOINT_URL_S3 must be set; see .env.example');
}

const s3 = new S3Client({});

const draft = (members: readonly string[]) => ({ key: 'beta', memberAttribute: 'userId', members });

const listKeys = async (bucket: string) => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return Contents.map(({ Key }) => Key);
};

const readJson = async (bucket: string, key: string): Promise<unknown> => {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse((await Body?.transformToString()) ?? '');
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
describe('createS3SegmentPublisher against LocalStack', () => {
  let bucket: string;

  const publisher = () => createS3SegmentPublisher({ bucket });

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

  it('publishes immutable versions and moves the pointer to each new one', async () => {
    const target = publisher();

    await expect(target.publish(ENVIRONMENT, draft(['u-1', '007']))).resolves.toMatchObject({ version: 1 });
    await expect(target.publish(ENVIRONMENT, draft(['u-2']))).resolves.toMatchObject({ version: 2 });

    expect((await listKeys(bucket)).sort()).toEqual([
      `${ENVIRONMENT}/segments/beta/1.json`,
      `${ENVIRONMENT}/segments/beta/2.json`,
      POINTER_KEY,
    ]);
    const pointer = parseSegmentPointer(await readJson(bucket, POINTER_KEY));
    expect(pointer).toMatchObject({ ok: true, value: { version: 2, objectKey: `${ENVIRONMENT}/segments/beta/2.json` } });
    expect(parseSegment(await readJson(bucket, `${ENVIRONMENT}/segments/beta/1.json`))).toMatchObject({
      ok: true,
      value: { key: 'beta', version: 1, members: ['u-1', '007'] },
    });
    expect(parseSegment(await readJson(bucket, `${ENVIRONMENT}/segments/beta/2.json`))).toMatchObject({
      ok: true,
      value: { version: 2, members: ['u-2'] },
    });
  });

  it('refuses to overwrite an existing version with VERSION_EXISTS and leaves the pointer alone', async () => {
    await publisher().publish(ENVIRONMENT, draft(['u-1']));
    const squatted = `${ENVIRONMENT}/segments/beta/2.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: squatted, Body: 'squatter' }));

    const error = await rejection(publisher().publish(ENVIRONMENT, draft(['u-2'])));

    expect(error).toBeInstanceOf(S3SegmentPublishError);
    expect(error).toMatchObject({ reason: 'VERSION_EXISTS', key: squatted });
    expect(await readJson(bucket, POINTER_KEY)).toMatchObject({ version: 1 });
  });

  it('lets exactly one of two concurrent first uploads win', async () => {
    const outcomes = await Promise.allSettled([
      publisher().publish(ENVIRONMENT, draft(['u-1'])),
      publisher().publish(ENVIRONMENT, draft(['u-2'])),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const [failure] = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failure?.reason).toBeInstanceOf(S3SegmentPublishError);
    expect(['VERSION_EXISTS', 'CONFLICT']).toContain((failure?.reason as S3SegmentPublishError).reason);
    expect(await readJson(bucket, POINTER_KEY)).toMatchObject({ version: 1 });
  });

  it('refuses a stale pointer move with CONFLICT', async () => {
    await publisher().publish(ENVIRONMENT, draft(['u-1']));
    const outcomes = await Promise.allSettled([
      publisher().publish(ENVIRONMENT, draft(['u-2'])),
      publisher().publish(ENVIRONMENT, draft(['u-3'])),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(await readJson(bucket, POINTER_KEY)).toMatchObject({ version: 2 });
  });
});
