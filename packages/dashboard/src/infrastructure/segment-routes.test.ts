import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SegmentPointer } from '@featuresync/aws';
import type { PublishedSegment, PublishedSegmentListing } from '../application/list-published-segments.js';
import { MAX_BODY_BYTES, startDashboardServer, type DashboardPorts, type RunningDashboard } from './http-server.js';
import { MAX_SEGMENT_CSV_BYTES } from './segment-routes.js';

const MEMBER = 'bob@x.io';

const pointerAt = (version: number): SegmentPointer => ({
  schemaVersion: 1,
  environment: 'production',
  segmentKey: 'beta',
  version,
  objectKey: `production/segments/beta/${String(version)}.json`,
});

const publishRejecting = (reason: string) => () => Promise.reject(Object.assign(new Error(reason), { reason }));

interface Fakes {
  readonly ports: DashboardPorts;
  readonly publishSegment: ReturnType<typeof vi.fn>;
  readonly readSegmentVersion: ReturnType<typeof vi.fn>;
}

const fakes = (overrides: Partial<DashboardPorts> = {}): Fakes => {
  const publishSegment = vi.fn(overrides.publishSegment ?? (() => Promise.resolve(pointerAt(5))));
  const readSegmentVersion = vi.fn(overrides.readSegmentVersion ?? (() => Promise.resolve(4)));
  return {
    publishSegment,
    readSegmentVersion,
    ports: {
      readCurrentVersion: () => Promise.resolve(3),
      fetchSnapshotText: () => Promise.resolve('{}'),
      openWriter: () => ({ publish: () => Promise.resolve(4), rollback: (_env: string, v: number) => Promise.resolve(v) }),
      publishSegment,
      readSegmentVersion,
      listPublishedSegments: overrides.listPublishedSegments ?? (() => Promise.resolve({ status: 'listed', segments: [] })),
    },
  };
};

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

let running: RunningDashboard | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const start = async (ports: DashboardPorts) => {
  running = await startDashboardServer({ ports, port: 0, logError: vi.fn() });
  return running;
};

const call = (
  dashboard: RunningDashboard,
  method: string,
  path: string,
  options: { body?: string | Buffer; sameOrigin?: boolean } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(options.sameOrigin === false ? {} : { origin: dashboard.url }),
    };
    const outgoing = httpRequest(new URL(path, dashboard.url), { method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: incoming.headers });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });

const upload = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

const SEGMENT_PATH = '/env/production/segments/beta';

describe('segment upload routes', () => {
  it('renders the segment page with the current version in the hidden field', async () => {
    const { ports, readSegmentVersion } = fakes({ readSegmentVersion: () => Promise.resolve(7) });
    const dashboard = await start(ports);

    const page = await call(dashboard, 'GET', SEGMENT_PATH);

    expect(page.status).toBe(200);
    expect(page.body).toContain('<input type="hidden" name="expectedCurrentVersion" value="7">');
    expect(page.body).toContain('segment beta');
    expect(readSegmentVersion).toHaveBeenCalledWith('production', 'beta');
  });

  it('renders an empty expected version for a segment that has never been published', async () => {
    const dashboard = await start(fakes({ readSegmentVersion: () => Promise.resolve(null) }).ports);

    const page = await call(dashboard, 'GET', SEGMENT_PATH);

    expect(page.body).toContain('<input type="hidden" name="expectedCurrentVersion" value="">');
    expect(page.body).toContain('never published');
  });

  it('escapes the segment key in the page', async () => {
    const dashboard = await start(fakes().ports);

    const page = await call(dashboard, 'GET', '/env/production/segments/a%3Cb');

    expect(page.body).toContain('a&lt;b');
    expect(page.body).not.toContain('segment a<b');
  });

  it('refuses an upload without the dashboard origin and never calls the port', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: '4' }),
      sameOrigin: false,
    });

    expect(reply.status).toBe(403);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('publishes a valid CSV and reports the new version without echoing members', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: `${MEMBER}\nu2`, expectedCurrentVersion: '4' }),
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Uploaded as version 5.');
    expect(reply.body).not.toContain(MEMBER);
    expect(publishSegment).toHaveBeenCalledWith('production', {
      key: 'beta',
      memberAttribute: 'userId',
      members: [MEMBER, 'u2'],
      expectedCurrentVersion: 4,
    });
  });

  it('sends null, not 0, when the expected version field is empty', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: '' }),
    });

    expect(publishSegment.mock.calls[0]?.[1]).toMatchObject({ expectedCurrentVersion: null });
  });

  it('rejects a non-numeric expected version with 400 and no port call', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: 'latest' }),
    });

    expect(reply.status).toBe(400);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('answers 400 for a malformed CSV row without showing the member on it', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: `u1\n${MEMBER},extra`, expectedCurrentVersion: '4' }),
    });

    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain(MEMBER);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('answers 400 for an empty file', async () => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: '', expectedCurrentVersion: '4' }),
    });

    expect(reply.status).toBe(400);
  });

  it('treats a form with no member attribute or file as an empty upload', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', SEGMENT_PATH, { body: 'expectedCurrentVersion=4' });

    expect(reply.status).toBe(400);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('answers 422 when the publisher reports a conflict, and 422 when the version already exists', async () => {
    const conflict = await start(fakes({ publishSegment: publishRejecting('CONFLICT') }).ports);
    const conflicted = await call(conflict, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: '4' }),
    });
    expect(conflicted.status).toBe(422);
    await conflict.close();
    running = undefined;

    const exists = await start(fakes({ publishSegment: publishRejecting('VERSION_EXISTS') }).ports);
    const existing = await call(exists, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: '4' }),
    });
    expect(existing.status).toBe(422);
  });

  it('answers 502 when the publisher fails for any other reason', async () => {
    const dashboard = await start(fakes({ publishSegment: publishRejecting('REQUEST_FAILED') }).ports);

    const reply = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: '4' }),
    });

    expect(reply.status).toBe(502);
  });

  it('accepts a body just under the upload limit but refuses one above it', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);
    // Padding rather than members: the point is the byte count the route accepts, not the CSV's size.
    const padding = 'x'.repeat(MAX_SEGMENT_CSV_BYTES - 1024);

    const large = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: `${upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: '4' })}&pad=${padding}`,
    });
    expect(large.status).toBe(200);

    const tooLarge = await call(dashboard, 'POST', SEGMENT_PATH, {
      body: Buffer.alloc(MAX_SEGMENT_CSV_BYTES + 1024, 'x'),
    });
    expect(tooLarge.status).toBe(413);
    expect(publishSegment).toHaveBeenCalledTimes(1);
  });

  it('keeps the 1 MiB limit on every other route', async () => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/dark', {
      body: `baseVersion=3&field=default&default=${'x'.repeat(MAX_BODY_BYTES)}`,
    });

    expect(reply.status).toBe(413);
  });

  it('answers 405 for a method the segment page does not accept', async () => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'DELETE', SEGMENT_PATH);

    expect(reply.status).toBe(405);
  });
});

const LIST_PATH = '/env/production/segments';

const snapshotText = (segmentKeys: readonly string[]): string =>
  JSON.stringify({
    schemaVersion: 2,
    environment: 'production',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'dashboard',
    previousVersion: null,
    reason: 'seed',
    features: Object.fromEntries(
      segmentKeys.map((key, index) => [
        `flag-${String(index)}`,
        { type: 'boolean', enabled: true, rules: [{ when: { userId: { inSegment: key } }, enabled: true }] },
      ]),
    ),
  });

const published = (segmentKey: string, memberAttribute?: string): PublishedSegment => ({
  segmentKey,
  version: 4,
  ...(memberAttribute === undefined ? {} : { memberAttribute }),
});

const listFakes = (listing: PublishedSegmentListing, referencedKeys: readonly string[] = []): DashboardPorts => ({
  ...fakes({ listPublishedSegments: () => Promise.resolve(listing) }).ports,
  readCurrentVersion: () => Promise.resolve(1),
  fetchSnapshotText: () => Promise.resolve(snapshotText(referencedKeys)),
});

describe('the segment list route', () => {
  it('lists every published segment with its version, attribute and using flags', async () => {
    const dashboard = await start(
      listFakes({ status: 'listed', segments: [published('beta', 'userId'), published('staff', 'accountId')] }, ['beta']),
    );

    const page = await call(dashboard, 'GET', LIST_PATH);

    expect(page.status).toBe(200);
    expect(page.body).toContain('>beta</a>');
    expect(page.body).toContain('>staff</a>');
    expect(page.body).toContain('version 4');
    expect(page.body).toContain('accountId');
    expect(page.body).toContain('>flag-0<');
  });

  it('shows a published segment no flag references, rather than filtering it out', async () => {
    const dashboard = await start(listFakes({ status: 'listed', segments: [published('staff', 'userId')] }));

    const page = await call(dashboard, 'GET', LIST_PATH);

    expect(page.status).toBe(200);
    expect(page.body).toContain('>staff</a>');
    expect(page.body).toContain('used by no flag');
  });

  it('marks a segment published before attributes were recorded instead of guessing one', async () => {
    const dashboard = await start(listFakes({ status: 'listed', segments: [published('legacy')] }));

    const page = await call(dashboard, 'GET', LIST_PATH);

    expect(page.status).toBe(200);
    expect(page.body).toContain('unknown (published before attributes were recorded)');
  });

  it('serves the page with a could-not-read state rather than a 500 when the catalogue is unavailable', async () => {
    const dashboard = await start(listFakes({ status: 'unavailable' }));

    const page = await call(dashboard, 'GET', LIST_PATH);

    expect(page.status).toBe(200);
    expect(page.body).toContain('The segment catalogue could not be read');
    expect(page.body).not.toContain('No segments published yet');
  });

  it('still serves the segment page and upload route for a four-part path', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    expect((await call(dashboard, 'GET', SEGMENT_PATH)).body).toContain('segment beta');
    await call(dashboard, 'POST', SEGMENT_PATH, {
      body: upload({ memberAttribute: 'userId', csv: 'u1', expectedCurrentVersion: '4' }),
    });
    expect(publishSegment).toHaveBeenCalledTimes(1);
  });

  it('answers 405 with both accepted methods for a method the list path does not take', async () => {
    const { ports, publishSegment } = fakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'PUT', LIST_PATH, { body: upload({ csv: 'u1' }) });

    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET, POST');
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('has no page at a deeper segment path', async () => {
    const dashboard = await start(fakes().ports);

    expect((await call(dashboard, 'GET', `${SEGMENT_PATH}/members`)).status).toBe(404);
  });
});

interface CreateFakes {
  readonly ports: DashboardPorts;
  readonly publishSegment: ReturnType<typeof vi.fn>;
  readonly readSegmentVersion: ReturnType<typeof vi.fn>;
}

const createFakes = (overrides: Partial<DashboardPorts> = {}): CreateFakes => {
  const base = fakes({ readSegmentVersion: () => Promise.resolve(null), ...overrides });
  return {
    ...base,
    ports: { ...base.ports, readCurrentVersion: () => Promise.resolve(1), fetchSnapshotText: () => Promise.resolve(snapshotText([])) },
  };
};

const createForm = (fields: Record<string, string>) => upload({ memberAttribute: 'userId', csv: 'u1', ...fields });

describe('creating a segment from the list page', () => {
  it('publishes a first version for a typed key and reports it on the list page', async () => {
    const { ports, publishSegment } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: 'beta', csv: `${MEMBER}\nu2` }) });

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Created as version 5.');
    expect(reply.body).not.toContain(MEMBER);
    expect(publishSegment).toHaveBeenCalledWith('production', {
      key: 'beta',
      memberAttribute: 'userId',
      members: [MEMBER, 'u2'],
      expectedCurrentVersion: null,
    });
  });

  it('still renders the list on GET', async () => {
    const dashboard = await start(listFakes({ status: 'listed', segments: [published('beta', 'userId')] }, ['beta']));

    const page = await call(dashboard, 'GET', LIST_PATH);

    expect(page.status).toBe(200);
    expect(page.body).toContain('>beta</a>');
    expect(page.body).not.toContain('class="notice');
  });

  it.each(['a.b', 'has space', '', '-leading', 'x'.repeat(65)])('answers 400 for the malformed key %j and publishes nothing', async (key) => {
    const { ports, publishSegment, readSegmentVersion } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key }) });

    expect(reply.status).toBe(400);
    expect(reply.body).toContain('not valid');
    expect(publishSegment).not.toHaveBeenCalled();
    expect(readSegmentVersion).not.toHaveBeenCalled();
  });

  it('validates the trimmed key the publisher would store', async () => {
    const { ports, publishSegment } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: '  beta  ' }) });

    expect(reply.status).toBe(200);
    expect(publishSegment.mock.calls[0]?.[1]).toMatchObject({ key: 'beta' });
  });

  it('puts the typed key and attribute back in the form when the submit is refused, and keeps the CSV out', async () => {
    const { ports } = createFakes({ readSegmentVersion: () => Promise.resolve(4) });
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, {
      body: createForm({ key: 'beta', memberAttribute: 'accountId', csv: MEMBER }),
    });

    expect(reply.status).toBe(422);
    expect(reply.body).toContain('name="key" value="beta"');
    expect(reply.body).toContain('name="memberAttribute" value="accountId"');
    expect(reply.body).not.toContain(MEMBER);
  });

  it('clears the form after a successful create', async () => {
    const { ports } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: 'beta', memberAttribute: 'accountId' }) });

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('name="key" value=""');
    expect(reply.body).toContain('name="memberAttribute" value="userId"');
  });

  it('answers 422 without publishing when the key is already published', async () => {
    const { ports, publishSegment } = createFakes({ readSegmentVersion: () => Promise.resolve(4) });
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: 'beta' }) });

    expect(reply.status).toBe(422);
    expect(reply.body).toContain('already in use');
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('answers 502 without publishing when the existing-key check cannot be read', async () => {
    const { ports, publishSegment } = createFakes({ readSegmentVersion: () => Promise.reject(new Error('boom')) });
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: 'beta' }) });

    expect(reply.status).toBe(502);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it.each([
    ['EMPTY_FILE', { csv: '' }, 400],
    ['MALFORMED_ROW', { csv: 'u1\nu2,extra' }, 400],
    ['HEADER', { memberAttribute: '' }, 400],
  ] as const)('maps the %s upload failure to %i as the key-bearing POST does', async (_reason, fields, status) => {
    const { ports, publishSegment } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: 'beta', ...fields }) });

    expect(reply.status).toBe(status);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it.each([
    ['CONFLICT', 422],
    ['VERSION_EXISTS', 422],
    ['REQUEST_FAILED', 502],
  ] as const)('maps a %s publisher rejection to %i', async (reason, status) => {
    const { ports } = createFakes({ publishSegment: publishRejecting(reason) });
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: 'beta' }) });

    expect(reply.status).toBe(status);
  });

  it('reads a create body far above the 1 MiB default', async () => {
    const { ports, publishSegment } = createFakes();
    const dashboard = await start(ports);
    // Padding rather than members: the point is the byte count the branch accepts.
    const padding = 'x'.repeat(MAX_BODY_BYTES * 2);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: `${createForm({ key: 'beta' })}&pad=${padding}` });

    expect(reply.status).toBe(200);
    expect(publishSegment).toHaveBeenCalledTimes(1);
  });

  it('answers 400 for a submission with no key field at all', async () => {
    const { ports, publishSegment } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: upload({ csv: 'u1' }) });

    expect(reply.status).toBe(400);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('treats a submission with a key but no member attribute or file as an empty upload', async () => {
    const { ports, publishSegment } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: 'key=beta' });

    expect(reply.status).toBe(400);
    expect(publishSegment).not.toHaveBeenCalled();
  });

  it('refuses a create without the dashboard origin and never calls the port', async () => {
    const { ports, publishSegment } = createFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', LIST_PATH, { body: createForm({ key: 'beta' }), sameOrigin: false });

    expect(reply.status).toBe(403);
    expect(publishSegment).not.toHaveBeenCalled();
  });
});
