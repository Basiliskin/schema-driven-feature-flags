import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { parseSegmentPointer } from '@featuresync/aws';
import { SEGMENT_SCHEMA_VERSION } from '@featuresync/core';
import { test as base } from '@playwright/test';
import type { RunningDashboard } from '../../src/infrastructure/http-server.js';
import { EXIT_OK, main, nodeIo } from '../../src/main.js';
import { seedPointerFor, seedSnapshotFor } from '../../test/support/seed-snapshot.js';

export const ENVIRONMENT = 'e2e';

const requireLocalStackEndpoint = (): string => {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  if (endpoint === undefined || endpoint === '') {
    throw new Error(
      'AWS_ENDPOINT_URL_S3 is not set, so these tests would talk to real AWS. ' +
        'Set it in the repo-root .env (see .env.example) locally, or in the CI job env.',
    );
  }
  return endpoint;
};

const putJson = (s3: S3Client, bucket: string, key: string, body: unknown): Promise<unknown> =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(body), ContentType: 'application/json' }));

const deleteEveryObject = async (s3: S3Client, bucket: string): Promise<void> => {
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }) }),
    );
    const objects = (page.Contents ?? []).flatMap(({ Key }) => (Key === undefined ? [] : [{ Key }]));
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    }
    continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
};

/** Publishes a segment at the key layout the S3 segment publisher uses, so the prefix lister finds it. */
export type SeedSegment = (segment: {
  readonly key: string;
  readonly version: number;
  readonly memberAttribute: string;
  readonly members: readonly string[];
}) => Promise<void>;

interface LocalStackFixtures {
  readonly bucket: string;
  readonly environment: string;
  readonly dashboard: RunningDashboard;
  readonly seedSegment: SeedSegment;
}

interface LocalStackWorkerFixtures {
  /** Shared across a worker's tests; each test still gets its own bucket. */
  readonly s3: S3Client;
}

export const test = base.extend<LocalStackFixtures, LocalStackWorkerFixtures>({
  s3: [
    // Playwright reads a fixture's dependencies from its destructuring pattern; this one needs none.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      requireLocalStackEndpoint();
      const s3 = new S3Client({});
      await use(s3);
      s3.destroy();
    },
    { scope: 'worker' },
  ],
  bucket: async ({ s3 }, use) => {
    const bucket = `featuresync-e2e-${randomUUID()}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await use(bucket);
    await deleteEveryObject(s3, bucket);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  },
  // eslint-disable-next-line no-empty-pattern
  environment: async ({}, use) => {
    await use(ENVIRONMENT);
  },
  seedSegment: async ({ s3, bucket, environment }, use) => {
    await use(async ({ key, version, memberAttribute, members }) => {
      const objectKey = `${environment}/segments/${key}/${String(version)}.json`;
      await putJson(s3, bucket, objectKey, {
        schemaVersion: SEGMENT_SCHEMA_VERSION,
        key,
        version,
        memberAttribute,
        members,
      });
      // Parsed rather than trusted: a seed the real pointer schema rejects would let the spec pass
      // against a shape no publisher can produce.
      const pointer = parseSegmentPointer({
        schemaVersion: 1,
        environment,
        segmentKey: key,
        version,
        objectKey,
        memberAttribute,
      });
      if (!pointer.ok) throw new Error(`The seeded pointer for ${key} is not a valid Segment Pointer`);
      await putJson(s3, bucket, `${environment}/segments/${key}/current.json`, pointer.value);
    });
  },
  dashboard: async ({ s3, bucket, environment }, use) => {
    const pointer = seedPointerFor(environment);
    await putJson(s3, bucket, pointer.snapshotKey, seedSnapshotFor(environment));
    await putJson(s3, bucket, `${environment}/current.json`, pointer);

    let dashboard: RunningDashboard | undefined;
    // env is emptied so only the explicit --bucket applies, never a developer's FEATURESYNC_BUCKET.
    const exitCode = await main(['--bucket', bucket, '--port', '0'], {
      ...nodeIo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      startServer: async (options) => {
        dashboard = await nodeIo.startServer(options);
        return dashboard;
      },
    });
    if (exitCode !== EXIT_OK || dashboard === undefined) {
      throw new Error(`The dashboard failed to start for bucket ${bucket}`);
    }
    const running = dashboard;
    await use(running);
    await running.close();
  },
});

export { expect } from '@playwright/test';
