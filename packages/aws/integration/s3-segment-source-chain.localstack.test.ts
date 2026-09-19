import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { createFeatureFlags, parseSnapshot, type FeatureFlags } from '@featuresync/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createS3SegmentPublisher, createS3SnapshotPublisher, createS3SnapshotSource, parseSegmentCsv } from '../src/index.js';

const POLL_INTERVAL_MS = 200;
const ENVIRONMENT = 'integration';
const SEGMENT = 'beta-testers';
const bucket = `featuresync-it-${randomUUID()}`;

// Guards against running this suite against real AWS when the local endpoint is not configured.
if (process.env.AWS_ENDPOINT_URL_S3 === undefined) {
  throw new Error('AWS_ENDPOINT_URL_S3 must be set; see .env.example');
}

const s3 = new S3Client({});

const snapshot = {
  schemaVersion: 2,
  environment: ENVIRONMENT,
  createdBy: 'integration-test',
  reason: 'segment chain',
  features: {
    beta: {
      type: 'boolean',
      enabled: true,
      rules: [{ when: { userId: { inSegment: SEGMENT } }, enabled: true }],
    },
    'beta-rollout': {
      type: 'boolean',
      enabled: true,
      rules: [
        {
          when: { userId: { inSegment: SEGMENT } },
          rollout: { percentage: 100, bucketBy: 'userId', salt: 'chain' },
          enabled: true,
        },
      ],
    },
  },
};

const uploadCsv = async (csv: string) => {
  const parsed = parseSegmentCsv(csv, { key: SEGMENT, version: 1, memberAttribute: 'userId' });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const { key, memberAttribute, members } = parsed.value;
  return createS3SegmentPublisher({ bucket }).publish(ENVIRONMENT, { key, memberAttribute, members });
};

const currentPointerEtag = async () =>
  (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${ENVIRONMENT}/current.json` }))).ETag;

const emptyBucket = async () => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  if (Contents.length === 0) return;
  await s3.send(
    new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: Contents.map(({ Key }) => ({ Key })) } }),
  );
};

// Pinned by docker/docker-compose.yml to localstack/localstack:2026.08.3.
describe('segment re-upload chain against LocalStack', () => {
  let flags: FeatureFlags | undefined;

  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    flags?.close();
    await emptyBucket();
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
  });

  it('changes evaluation after a CSV re-upload without republishing the snapshot', async () => {
    await createS3SnapshotPublisher({ bucket, validate: parseSnapshot }).publish(ENVIRONMENT, snapshot);
    await uploadCsv('userId\nalice\n');

    flags = createFeatureFlags({
      source: createS3SnapshotSource({ bucket, environment: ENVIRONMENT, pollIntervalMs: POLL_INTERVAL_MS }),
    });
    await flags.ready();
    const client = flags;
    const enabledFor = (key: string, userId: string) => client.isEnabled(key, { userId });

    expect(enabledFor('beta', 'alice')).toBe(true);
    expect(enabledFor('beta', 'bob')).toBe(false);
    expect(enabledFor('beta-rollout', 'alice')).toBe(true);
    expect(enabledFor('beta-rollout', 'bob')).toBe(false);
    const snapshotVersion = client.version();
    const pointerEtag = await currentPointerEtag();

    await expect(uploadCsv('userId\nbob\n')).resolves.toMatchObject({ version: 2 });
    await vi.waitFor(
      () => {
        if (!enabledFor('beta', 'bob')) throw new Error('the re-uploaded segment has not reached the flag client');
      },
      { timeout: 10_000, interval: 25 },
    );

    expect(enabledFor('beta', 'alice')).toBe(false);
    expect(enabledFor('beta-rollout', 'bob')).toBe(true);
    expect(enabledFor('beta-rollout', 'alice')).toBe(false);
    expect(client.version()).toBe(snapshotVersion);
    expect(await currentPointerEtag()).toBe(pointerEtag);
  });
});
