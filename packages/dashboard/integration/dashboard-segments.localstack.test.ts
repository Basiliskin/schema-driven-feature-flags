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
import { parseSegment, parseSnapshot } from '@featuresync/core';
import { parseSegmentPointer } from '@featuresync/aws';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDashboard } from '../src/infrastructure/http-server.js';
import { EXIT_OK, main, nodeIo } from '../src/main.js';

const ENVIRONMENT = 'integration';
const SEGMENT_KEY = 'beta';
const MEMBER_ATTRIBUTE = 'userId';
// Synthetic ids only: a failure dump of this test is printed in CI.
const CSV = `${MEMBER_ATTRIBUTE}\nuser-1\nuser-2\nuser-3\n`;
const MEMBER_COUNT = 3;

// Guards against running this suite against real AWS when the local endpoint is not configured.
if (process.env.AWS_ENDPOINT_URL_S3 === undefined) {
  throw new Error('AWS_ENDPOINT_URL_S3 must be set; see .env.example');
}

const s3 = new S3Client({});

// The first schemaVersion 2 snapshot in the repository: a Percentage Rollout is rejected on schemaVersion 1.
const seedSnapshot = {
  schemaVersion: 2,
  environment: ENVIRONMENT,
  version: 1,
  createdAt: '2026-09-20T06:00:00.000Z',
  createdBy: 'integration',
  previousVersion: null,
  reason: 'seed',
  features: {
    checkout: {
      type: 'config',
      enabled: true,
      default: { provider: 'stripe' },
      rules: [{ when: { [MEMBER_ATTRIBUTE]: { inSegment: SEGMENT_KEY } }, value: { provider: 'adyen' } }],
    },
  },
};

const seedPointer = {
  schemaVersion: 1,
  environment: ENVIRONMENT,
  version: 1,
  snapshotKey: `${ENVIRONMENT}/snapshots/1.json`,
};

const listKeys = async (bucket: string) => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return Contents.map(({ Key }) => Key);
};

// Pinned by docker/docker-compose.yml to localstack/localstack:2026.08.3.
describe('featuresync-dashboard segments and rollout against LocalStack', () => {
  let bucket: string;
  let dashboard: RunningDashboard;

  const post = (path: string, form: Record<string, string>) =>
    fetch(`${dashboard.url}${path}`, {
      method: 'POST',
      headers: { origin: dashboard.url },
      body: new URLSearchParams(form),
    });

  const objectText = async (key: string) => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (object.Body as { transformToString: () => Promise<string> }).transformToString();
  };

  const put = (key: string, body: unknown) =>
    s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(body), ContentType: 'application/json' }),
    );

  const segmentPointer = async () => {
    const parsed = parseSegmentPointer(JSON.parse(await objectText(`${ENVIRONMENT}/segments/${SEGMENT_KEY}/current.json`)));
    if (!parsed.ok) throw new Error(`The Segment Pointer is not a valid pointer: ${JSON.stringify(parsed.error.issues)}`);
    return parsed.value;
  };

  // Located through the pointer's own objectKey, so an orphan left by a lost compare-and-set cannot satisfy it.
  const publishedSegment = async () => {
    const pointer = await segmentPointer();
    const parsed = parseSegment(JSON.parse(await objectText(pointer.objectKey)));
    if (!parsed.ok) throw new Error(`The Segment Version is not a valid segment: ${parsed.error.message}`);
    return { pointer, segment: parsed.value };
  };

  const snapshotVersion = async (version: number) => {
    const parsed = parseSnapshot(JSON.parse(await objectText(`${ENVIRONMENT}/snapshots/${String(version)}.json`)));
    if (!parsed.ok) throw new Error(`Snapshot ${String(version)} is not a valid snapshot: ${parsed.error.message}`);
    return parsed.value;
  };

  const checkoutRule = (snapshot: Awaited<ReturnType<typeof snapshotVersion>>) => {
    const feature = snapshot.features.checkout;
    if (feature === undefined) throw new Error('The seeded checkout flag is missing from the published snapshot');
    const rule = feature.rules[0];
    if (rule === undefined) throw new Error('The seeded checkout rule is missing from the published snapshot');
    return rule;
  };

  const uploadCsv = () =>
    post(`/env/${ENVIRONMENT}/segments/${SEGMENT_KEY}`, {
      memberAttribute: MEMBER_ATTRIBUTE,
      csv: CSV,
      expectedCurrentVersion: '',
    });

  const editRollout = (form: Record<string, string>) =>
    post(`/env/${ENVIRONMENT}/features/checkout`, { baseVersion: '1', ruleIndex: '0', ...form });

  beforeEach(async () => {
    bucket = `featuresync-it-${randomUUID()}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const exitCode = await main(['--bucket', bucket, '--port', '0'], {
      ...nodeIo,
      env: {},
      out: () => undefined,
      startServer: async (options) => {
        dashboard = await nodeIo.startServer(options);
        return dashboard;
      },
    });
    expect(exitCode).toBe(EXIT_OK);
    await put(seedPointer.snapshotKey, seedSnapshot);
    await put(`${ENVIRONMENT}/current.json`, seedPointer);
  });

  afterEach(async () => {
    await dashboard.close();
    const keys = await listKeys(bucket);
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  });

  afterAll(() => {
    s3.destroy();
  });

  it('uploads a segment CSV as a Segment Version the Segment Pointer names', async () => {
    const uploaded = await uploadCsv();
    expect(uploaded.status).toBe(200);

    const { pointer, segment } = await publishedSegment();

    expect(pointer).toMatchObject({
      environment: ENVIRONMENT,
      segmentKey: SEGMENT_KEY,
      version: 1,
      objectKey: `${ENVIRONMENT}/segments/${SEGMENT_KEY}/1.json`,
    });
    expect(segment.version).toBe(pointer.version);
    expect(segment.key).toBe(SEGMENT_KEY);
    expect(segment.memberAttribute).toBe(MEMBER_ATTRIBUTE);
    expect(segment.members).toHaveLength(MEMBER_COUNT);
  });

  it('moves the Segment Pointer to the second version on a re-upload', async () => {
    expect((await uploadCsv()).status).toBe(200);

    const reuploaded = await post(`/env/${ENVIRONMENT}/segments/${SEGMENT_KEY}`, {
      memberAttribute: MEMBER_ATTRIBUTE,
      csv: `${MEMBER_ATTRIBUTE}\nuser-1\n`,
      expectedCurrentVersion: '1',
    });
    expect(reuploaded.status).toBe(200);

    const { pointer, segment } = await publishedSegment();

    expect(pointer.version).toBe(2);
    expect(pointer.objectKey).toBe(`${ENVIRONMENT}/segments/${SEGMENT_KEY}/2.json`);
    expect(segment.version).toBe(2);
    expect(segment.members).toHaveLength(1);
  });

  it('adds a Percentage Rollout to a rule and then removes it across snapshot versions', async () => {
    const added = await editRollout({ field: 'setRollout', percentage: '25', bucketBy: MEMBER_ATTRIBUTE, salt: 'autumn' });
    expect(added.status).toBe(200);

    const withRollout = await snapshotVersion(2);
    expect(checkoutRule(withRollout).rollout).toEqual({ percentage: 25, bucketBy: MEMBER_ATTRIBUTE, salt: 'autumn' });
    expect(withRollout.version).toBe(2);

    const removed = await post(`/env/${ENVIRONMENT}/features/checkout`, {
      baseVersion: '2',
      ruleIndex: '0',
      field: 'removeRollout',
    });
    expect(removed.status).toBe(200);

    const withoutRollout = await snapshotVersion(3);
    expect(checkoutRule(withoutRollout)).not.toHaveProperty('rollout');
    expect(withoutRollout.version).toBeGreaterThan(withRollout.version);
    expect(checkoutRule(withoutRollout).when).toEqual(checkoutRule(withRollout).when);
  });
});
