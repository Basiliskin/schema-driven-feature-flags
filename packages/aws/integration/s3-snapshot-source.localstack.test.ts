import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Logger, Unsubscribe } from '@featuresync/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createS3SnapshotSource } from '../src/infrastructure/s3-snapshot-source.js';

const POLL_INTERVAL_MS = 200;
const ENVIRONMENT = 'integration';
const bucket = `featuresync-it-${randomUUID()}`;

// Guards against running this suite against real AWS when the local endpoint is not configured.
if (process.env.AWS_ENDPOINT_URL_S3 === undefined) {
  throw new Error('AWS_ENDPOINT_URL_S3 must be set; see .env.example');
}

const s3 = new S3Client({});

const put = (key: string, body: unknown) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(body) }));

const publish = async (version: number) => {
  const snapshotKey = `${ENVIRONMENT}/snapshots/${String(version)}.json`;
  await put(snapshotKey, { version });
  await put(`${ENVIRONMENT}/current.json`, { schemaVersion: 1, environment: ENVIRONMENT, version, snapshotKey });
};

const pollUntil = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${String(timeoutMs)}ms`);
    await sleep(25);
  }
};

const emptyBucket = async () => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  if (Contents.length === 0) return;
  await s3.send(
    new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: Contents.map(({ Key }) => ({ Key })) } }),
  );
};

describe('createS3SnapshotSource against LocalStack', () => {
  let unsubscribe: Unsubscribe | undefined;

  const subscribe = (onChange: (snapshot: unknown) => void, logger?: Logger) => {
    const source = createS3SnapshotSource({
      bucket,
      environment: ENVIRONMENT,
      pollIntervalMs: POLL_INTERVAL_MS,
      ...(logger === undefined ? {} : { logger }),
    });
    if (source.subscribe === undefined) throw new Error('expected a subscribe method');
    unsubscribe = source.subscribe(onChange);
    return source;
  };

  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterEach(async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    await emptyBucket();
  });

  afterAll(async () => {
    await emptyBucket();
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
  });

  it('loads the snapshot the current pointer names', async () => {
    await publish(1);
    const source = createS3SnapshotSource({ bucket, environment: ENVIRONMENT });

    await expect(source.load()).resolves.toEqual({ version: 1 });
  });

  it('delivers a pointer change to a subscriber exactly once', async () => {
    await publish(1);
    const onChange = vi.fn();
    const source = subscribe(onChange);
    await source.load();

    await publish(2);
    await pollUntil(() => onChange.mock.calls.length > 0);
    await sleep(POLL_INTERVAL_MS * 3);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ version: 2 });
  });

  it('gets a 304 and does not deliver while the pointer is unchanged', async () => {
    await publish(1);
    const onChange = vi.fn();
    const logger = { error: vi.fn<Logger['error']>() };
    const source = subscribe(onChange, logger);
    await source.load();
    const send = vi.spyOn(S3Client.prototype, 'send');

    await pollUntil(() => send.mock.calls.length >= 3);
    const outcomes = await Promise.allSettled(send.mock.results.map(({ value }) => value as Promise<unknown>));
    send.mockRestore();

    expect(outcomes.length).toBeGreaterThanOrEqual(3);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ status: 'rejected', reason: { $metadata: { httpStatusCode: 304 } } });
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
