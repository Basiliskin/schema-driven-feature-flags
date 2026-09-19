import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDashboard } from '../src/infrastructure/http-server.js';
import { EXIT_OK, main, nodeIo } from '../src/main.js';

const ENVIRONMENT = 'integration';

// Guards against running this suite against real AWS when the local endpoint is not configured.
if (process.env.AWS_ENDPOINT_URL_S3 === undefined) {
  throw new Error('AWS_ENDPOINT_URL_S3 must be set; see .env.example');
}

const s3 = new S3Client({});

const snapshot = (version: number, enabled: boolean) => ({
  schemaVersion: 1,
  environment: ENVIRONMENT,
  version,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'integration',
  previousVersion: version === 1 ? null : version - 1,
  reason: `publish ${String(version)}`,
  features: { 'new-dashboard': { type: 'boolean', enabled } },
});

const listKeys = async (bucket: string) => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return Contents.map(({ Key }) => Key);
};

// Pinned by docker/docker-compose.yml to localstack/localstack:2026.08.3.
describe('featuresync-dashboard against LocalStack', () => {
  let bucket: string;
  let dashboard: RunningDashboard;

  const post = (path: string, form: Record<string, string>) =>
    fetch(`${dashboard.url}${path}`, {
      method: 'POST',
      headers: { origin: dashboard.url },
      body: new URLSearchParams(form),
    });

  const page = async (path: string) => {
    const response = await fetch(`${dashboard.url}${path}`);
    return { status: response.status, html: await response.text() };
  };

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

  it('shows an empty environment, publishes, browses versions and rolls back', async () => {
    const empty = await page(`/env/${ENVIRONMENT}`);
    expect(empty.status).toBe(200);
    expect(empty.html).not.toContain('Current flags');

    for (const [version, enabled] of [
      [1, false],
      [2, true],
    ] as const) {
      const published = await post(`/env/${ENVIRONMENT}/publish`, {
        snapshot: JSON.stringify(snapshot(version, enabled)),
      });
      expect(published.status).toBe(200);
    }

    const current = await page(`/env/${ENVIRONMENT}`);
    expect(current.html).toContain('Current flags (version 2)');
    expect(current.html).toContain('Version 1');
    expect(current.html).toContain('Version 2</a> (current)');
    expect(current.html).toContain('new-dashboard');

    const first = await page(`/env/${ENVIRONMENT}/versions/1`);
    expect(first.status).toBe(200);
    expect(first.html).toContain('new-dashboard');

    const rolledBack = await post(`/env/${ENVIRONMENT}/rollback`, { version: '1' });
    expect(rolledBack.status).toBe(200);
    const afterRollback = await rolledBack.text();
    expect(afterRollback).toContain('Current flags (version 1)');
    expect(afterRollback).not.toContain('Version 2</a>');
    expect(await listKeys(bucket)).toContain(`${ENVIRONMENT}/snapshots/2.json`);
  });

  it('refuses a publish from another origin', async () => {
    const response = await fetch(`${dashboard.url}/env/${ENVIRONMENT}/publish`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: new URLSearchParams({ snapshot: JSON.stringify(snapshot(1, true)) }),
    });

    expect(response.status).toBe(403);
    expect(await listKeys(bucket)).toEqual([]);
  });
});
