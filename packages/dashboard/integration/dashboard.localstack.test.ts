import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
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

const editableSnapshot = {
  schemaVersion: 1,
  environment: ENVIRONMENT,
  version: 1,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'integration',
  previousVersion: null,
  reason: 'seed',
  features: {
    'new-dashboard': { type: 'boolean', enabled: true },
    checkout: {
      type: 'config',
      enabled: true,
      default: { provider: 'stripe' },
      rules: [{ when: { plan: 'pro' }, value: { provider: 'adyen' } }],
    },
  },
};

const METADATA_PATHS = ['createdAt', 'createdBy', 'previousVersion', 'reason', 'version'];

const differingPaths = (before: unknown, after: unknown, prefix = ''): string[] => {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(before) || !isObject(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => differingPaths(before[key], after[key], prefix === '' ? key : `${prefix}.${key}`));
};

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

  const snapshotText = async (version: number) => {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: `${ENVIRONMENT}/snapshots/${String(version)}.json` }),
    );
    return (object.Body as { transformToString: () => Promise<string> }).transformToString();
  };

  const currentPointerText = async () => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${ENVIRONMENT}/current.json` }));
    return (object.Body as { transformToString: () => Promise<string> }).transformToString();
  };

  const snapshotExists = async (version: number) => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${ENVIRONMENT}/snapshots/${String(version)}.json` }));
      return true;
    } catch (error) {
      if ((error as { name?: unknown }).name === 'NotFound') return false;
      throw error;
    }
  };

  const seed = async (snapshotBody: unknown) => {
    const published = await post(`/env/${ENVIRONMENT}/publish`, { snapshot: JSON.stringify(snapshotBody) });
    expect(published.status).toBe(200);
  };

  const disableNewDashboard = (baseVersion: number) =>
    post(`/env/${ENVIRONMENT}/features/new-dashboard`, { baseVersion: String(baseVersion), field: 'enabled' });

  afterAll(() => {
    s3.destroy();
  });

  it('shows an empty environment, publishes, browses versions and rolls back', async () => {
    const empty = await page(`/env/${ENVIRONMENT}`);
    expect(empty.status).toBe(200);
    expect(empty.html).not.toContain('Current snapshot');

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
    expect(current.html).toContain('Current snapshot · v2');
    expect(current.html).toContain('Version 1');
    expect(current.html).toContain('Version 2</a><span class="badge badge-accent">current</span>');
    expect(current.html).toContain('new-dashboard');

    const first = await page(`/env/${ENVIRONMENT}/versions/1`);
    expect(first.status).toBe(200);
    expect(first.html).toContain('new-dashboard');

    const rolledBack = await post(`/env/${ENVIRONMENT}/rollback`, { version: '1' });
    expect(rolledBack.status).toBe(200);
    const afterRollback = await rolledBack.text();
    expect(afterRollback).toContain('Restored version 1 of');
    expect(afterRollback).toContain('Current snapshot · v3');
    expect(afterRollback).toContain('Version 2</a>');
    expect(afterRollback).toContain('Version 3</a><span class="badge badge-accent">current</span>');
    expect(await listKeys(bucket)).toContain(`${ENVIRONMENT}/snapshots/3.json`);
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

  it('publishes an enabled edit as version 2 that differs only in that field and the metadata', async () => {
    await seed(editableSnapshot);

    const edited = await disableNewDashboard(1);

    expect(edited.status).toBe(200);
    expect(await edited.text()).toContain('Published version 2 to integration.');
    const before = JSON.parse(await snapshotText(1)) as typeof editableSnapshot;
    const after = JSON.parse(await snapshotText(2)) as typeof editableSnapshot;
    expect(differingPaths(before, after).sort()).toEqual(
      ['features.new-dashboard.enabled', ...METADATA_PATHS].sort(),
    );
    expect(after.features['new-dashboard']).toEqual({ type: 'boolean', enabled: false });
    expect(after.features['new-dashboard']).not.toHaveProperty('rules');
    expect(after.features.checkout).toEqual(before.features.checkout);
    expect(after).toMatchObject({ version: 2, previousVersion: 1, createdBy: 'dashboard' });
  });

  it('publishes a config default edit and leaves the other features unchanged', async () => {
    await seed(editableSnapshot);

    const edited = await post(`/env/${ENVIRONMENT}/features/checkout`, {
      baseVersion: '1',
      field: 'default',
      default: '{"provider":"paypal"}',
    });

    expect(edited.status).toBe(200);
    const before = JSON.parse(await snapshotText(1)) as typeof editableSnapshot;
    const after = JSON.parse(await snapshotText(2)) as typeof editableSnapshot;
    expect(after.features.checkout.default).toEqual({ provider: 'paypal' });
    expect(differingPaths(before, after).sort()).toEqual(['features.checkout.default.provider', ...METADATA_PATHS].sort());
    expect(after.features['new-dashboard']).toEqual(before.features['new-dashboard']);
    expect(after.features.checkout.rules).toEqual(before.features.checkout.rules);
  });

  it('refuses a second sequential edit on the same base with the reload message', async () => {
    await seed(editableSnapshot);

    const first = await disableNewDashboard(1);
    const second = await post(`/env/${ENVIRONMENT}/features/checkout`, {
      baseVersion: '1',
      field: 'enabled',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(422);
    expect(await second.text()).toContain('Someone else published version 2 meanwhile — reload and redo your edit.');
    expect((await listKeys(bucket)).sort()).toEqual(
      [`${ENVIRONMENT}/current.json`, `${ENVIRONMENT}/snapshots/1.json`, `${ENVIRONMENT}/snapshots/2.json`].sort(),
    );
    expect(JSON.parse(await currentPointerText())).toMatchObject({ version: 2 });
  });

  it('publishes exactly one of two concurrent edits on the same base', async () => {
    await seed(editableSnapshot);

    const responses = await Promise.all([
      disableNewDashboard(1),
      post(`/env/${ENVIRONMENT}/features/checkout`, { baseVersion: '1', field: 'enabled' }),
    ]);
    const replies = await Promise.all(
      responses.map(async (response) => ({ status: response.status, html: await response.text() })),
    );

    expect(replies.map(({ status }) => status).sort()).toEqual([200, 422]);
    const winner = replies[0]?.status === 200 ? 'new-dashboard' : 'checkout';
    const loser = replies.find(({ status }) => status === 422);
    expect(loser?.html).toContain('reload and redo your edit.');
    expect((await listKeys(bucket)).sort()).toEqual(
      [`${ENVIRONMENT}/current.json`, `${ENVIRONMENT}/snapshots/1.json`, `${ENVIRONMENT}/snapshots/2.json`].sort(),
    );
    expect(await snapshotExists(2)).toBe(true);
    expect(await snapshotExists(3)).toBe(false);
    expect(JSON.parse(await currentPointerText())).toMatchObject({ version: 2 });
    const published = JSON.parse(await snapshotText(2)) as typeof editableSnapshot;
    expect(published.features[winner].enabled).toBe(false);
    expect(published.features[winner === 'checkout' ? 'new-dashboard' : 'checkout'].enabled).toBe(true);
  });

  it('edits a flag right after a rollback as the next version', async () => {
    await seed(editableSnapshot);
    await seed({ ...editableSnapshot, version: 2, previousVersion: 1, reason: 'second' });
    const rolledBack = await post(`/env/${ENVIRONMENT}/rollback`, { version: '1' });
    expect(rolledBack.status).toBe(200);
    expect(JSON.parse(await currentPointerText())).toMatchObject({ version: 3 });

    const edited = await disableNewDashboard(3);

    expect(edited.status).toBe(200);
    expect(await edited.text()).toContain('Published version 4');
    expect(JSON.parse(await currentPointerText())).toMatchObject({ version: 4 });
    const published = JSON.parse(await snapshotText(4)) as Omit<typeof editableSnapshot, 'previousVersion'> & { previousVersion: number };
    expect(published).toMatchObject({ version: 4, previousVersion: 3 });
    expect(published.features['new-dashboard'].enabled).toBe(false);
  });

  it.each<[string, string, Record<string, string>, readonly string[]]>([
    [
      'creates a flag',
      '/features',
      { key: 'beta', type: 'config', enabled: 'on', default: '{"tier":1}' },
      ['features.beta'],
    ],
    [
      'edits the rules of a flag',
      '/features/new-dashboard',
      { field: 'rules', rules: '[{"when":{"plan":"pro"},"enabled":false}]' },
      ['features.new-dashboard.rules'],
    ],
    ['deletes a flag', '/features/checkout', { field: 'delete' }, ['features.checkout']],
  ])('%s as exactly one new version that differs only in that flag and the metadata', async (_, path, form, paths) => {
    await seed(editableSnapshot);

    const response = await post(`/env/${ENVIRONMENT}${path}`, { baseVersion: '1', ...form });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Published version 2 to integration.');
    expect(await snapshotExists(3)).toBe(false);
    const before = JSON.parse(await snapshotText(1)) as unknown;
    const after = JSON.parse(await snapshotText(2)) as unknown;
    expect(differingPaths(before, after).sort()).toEqual([...paths, ...METADATA_PATHS].sort());
  });

  it('refuses a duplicate key without writing anything', async () => {
    await seed(editableSnapshot);

    const response = await post(`/env/${ENVIRONMENT}/features`, { baseVersion: '1', key: 'checkout', type: 'boolean' });

    expect(response.status).toBe(422);
    expect(await snapshotExists(2)).toBe(false);
    expect(JSON.parse(await currentPointerText())).toMatchObject({ version: 1 });
  });
});
