import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotWriter } from '../application/publish-snapshot.js';
import { MAX_BODY_BYTES, startDashboardServer, type DashboardPorts, type RunningDashboard } from './http-server.js';

const snapshotText = (features: Record<string, unknown>) =>
  JSON.stringify({
    schemaVersion: 1,
    environment: 'production',
    version: 1,
    createdAt: '2026-09-19T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: null,
    reason: 'test',
    features,
  });

const VALID = snapshotText({
  'new-dashboard': { type: 'boolean', enabled: true },
  'checkout-limits': { type: 'config', enabled: false, default: { max: 3 } },
});

const NOW = new Date('2026-09-19T12:00:00.000Z');

interface Fakes {
  readonly ports: DashboardPorts;
  readonly writer: { publish: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> };
  readonly openWriter: ReturnType<typeof vi.fn>;
}

const fakes = (overrides: Partial<DashboardPorts> = {}, writer: Partial<SnapshotWriter> = {}): Fakes => {
  const fakeWriter = {
    publish: vi.fn(writer.publish ?? (() => Promise.resolve(4))),
    rollback: vi.fn(writer.rollback ?? ((_env: string, version: number) => Promise.resolve(version))),
  };
  const openWriter = vi.fn(() => fakeWriter);
  return {
    writer: fakeWriter,
    openWriter,
    ports: {
      now: () => NOW,
      readCurrentVersion: () => Promise.resolve(3),
      fetchSnapshotText: () => Promise.resolve(VALID),
      openWriter,
      ...overrides,
    },
  };
};

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

let running: RunningDashboard | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const start = async (ports: DashboardPorts, logError: (error: unknown) => void = vi.fn()) => {
  running = await startDashboardServer({ ports, port: 0, logError });
  return running;
};

const call = (
  dashboard: RunningDashboard,
  method: string,
  path: string,
  options: { body?: string; headers?: OutgoingHttpHeaders; sameOrigin?: boolean } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(options.sameOrigin === false ? {} : { origin: dashboard.url }),
      ...options.headers,
    };
    const outgoing = httpRequest(new URL(path, dashboard.url), { method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

describe('startDashboardServer', () => {
  it('listens on the loopback address only', async () => {
    const dashboard = await start(fakes().ports);

    expect(new URL(dashboard.url).hostname).toBe('127.0.0.1');
  });

  it('rejects when the port is already taken, and close() rejects when already closed', async () => {
    const first = await start(fakes().ports);
    const port = Number(new URL(first.url).port);

    await expect(startDashboardServer({ ports: fakes().ports, port })).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await first.close();
    await expect(first.close()).rejects.toThrow();
    running = undefined;
  });

  it('renders the environment picker and redirects a picked environment to its page', async () => {
    const dashboard = await start(fakes().ports);

    const home = await call(dashboard, 'GET', '/');
    expect(home.status).toBe(200);
    expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(home.body).toContain('<input name="env" required>');

    const blank = await call(dashboard, 'GET', '/?env=');
    expect(blank.status).toBe(200);

    const picked = await call(dashboard, 'GET', '/?env=eu%2Fprod');
    expect(picked.status).toBe(303);
    expect(picked.headers.location).toBe('/env/eu%2Fprod');
  });

  it('renders a published environment with flags, versions, rollback buttons and the rollback note', async () => {
    const dashboard = await start(fakes().ports);

    const page = await call(dashboard, 'GET', '/env/production');

    expect(page.status).toBe(200);
    expect(page.body).toContain('<td>new-dashboard</td><td>boolean</td><td>true</td><td><code>true</code></td>');
    expect(page.body).toContain('<code>{&quot;max&quot;:3}</code>');
    expect(page.body).toContain('<a href="/env/production/versions/3">Version 3</a> (current)');
    expect(page.body).toContain('value="1"');
    expect(page.body).toContain('Roll back to 2');
    expect(page.body).not.toContain('Roll back to 3');
    expect(page.body).toContain('the next publish fails with “version exists”');
    expect(page.body).toContain('delete or move those newer');
  });

  it('renders the empty, invalid, flagless and unavailable current-version states', async () => {
    const empty = await start(fakes({ readCurrentVersion: () => Promise.resolve(undefined) }).ports);
    const emptyPage = await call(empty, 'GET', '/env/staging');
    expect(emptyPage.body).toContain('Nothing has been published to this environment yet.');
    expect(emptyPage.body).toContain('the next publish fails with “version exists”');
    await empty.close();

    const invalid = await start(fakes({ fetchSnapshotText: () => Promise.resolve('{"schemaVersion":2}') }).ports);
    expect((await call(invalid, 'GET', '/env/production')).body).toContain('This snapshot is not valid:');
    await invalid.close();

    const flagless = await start(fakes({ fetchSnapshotText: () => Promise.resolve(snapshotText({})) }).ports);
    expect((await call(flagless, 'GET', '/env/production')).body).toContain('This snapshot defines no flags.');
    await flagless.close();

    const missing = Object.assign(new Error('gone'), { reason: 'SNAPSHOT_NOT_FOUND' });
    const gone = await start(fakes({ fetchSnapshotText: () => Promise.reject(missing) }).ports);
    expect((await call(gone, 'GET', '/env/production')).body).toContain('snapshot file is not available');
  });

  it('renders one snapshot version, including a missing one', async () => {
    const fetchSnapshotText = vi.fn((_env: string, version: number) =>
      version === 2
        ? Promise.resolve(VALID)
        : Promise.reject(Object.assign(new Error('gone'), { reason: 'SNAPSHOT_NOT_FOUND' })),
    );
    const dashboard = await start(fakes({ fetchSnapshotText }).ports);

    const page = await call(dashboard, 'GET', '/env/production/versions/2');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<h1>production · version 2</h1>');
    expect(page.body).toContain('<td>checkout-limits</td>');
    expect(page.body).toContain('<a href="/env/production">Back to production</a>');
    expect(fetchSnapshotText).toHaveBeenCalledWith('production', 2);

    const missing = await call(dashboard, 'GET', '/env/production/versions/9');
    expect(missing.body).toContain('This version is not available in this environment.');
  });

  it.each(['abc', '0', '01', '-1', '1.5', '9999999999'])('answers 400 for version %s', async (version) => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'GET', `/env/production/versions/${version}`);

    expect(reply.status).toBe(400);
    expect(reply.body).toContain('The version must be a positive integer.');
  });

  it('decodes percent-encoded environment names and answers 400 for malformed encoding', async () => {
    const readCurrentVersion = vi.fn(() => Promise.resolve(undefined));
    const dashboard = await start(fakes({ readCurrentVersion }).ports);

    await call(dashboard, 'GET', '/env/eu%20west');
    expect(readCurrentVersion).toHaveBeenCalledWith('eu west');

    expect((await call(dashboard, 'GET', '/env/%E0%A4%A')).status).toBe(400);
  });

  it('HTML-escapes environment names, flag keys and values, including in attributes', async () => {
    const fetchSnapshotText = vi.fn((_env: string, version: number) =>
      Promise.resolve(
        version === 3
          ? snapshotText({ 'x"&<y': { type: 'boolean', enabled: true } })
          : snapshotText({ limits: { type: 'config', enabled: true, default: '<b>"&</b>' } }),
      ),
    );
    const dashboard = await start(fakes({ fetchSnapshotText }).ports);
    const environment = encodeURIComponent('<script>"\'');

    const page = await call(dashboard, 'GET', `/env/${environment}`);
    const version = await call(dashboard, 'GET', `/env/${environment}/versions/2`);

    expect(page.body).not.toContain('<script>');
    expect(page.body).toContain('Environment &lt;script&gt;&quot;&#39;');
    expect(page.body).toContain('<li>features.x&quot;&amp;&lt;y: ');
    expect(version.body).not.toContain('<b>');
    expect(version.body).toContain('<code>&quot;&lt;b&gt;\\&quot;&amp;&lt;/b&gt;&quot;</code>');
    expect(page.body).toContain('href="/env/%3Cscript%3E%22\'/versions/3"'.replace("'", '&#39;'));
  });

  describe('POST /env/:env/publish', () => {
    it('publishes the pasted JSON through a writer opened for this request', async () => {
      const { ports, writer, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/publish', { body: form({ snapshot: VALID }) });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('Published version 4 to production.');
      expect(reply.body).toContain('></textarea>');
      expect(openWriter).toHaveBeenCalledTimes(1);
      expect(writer.publish).toHaveBeenCalledWith('production', JSON.parse(VALID));
    });

    it('shows the change-notification warning next to the success message', async () => {
      const { ports } = fakes({
        openWriter: (onNotifyError) => ({
          publish: () => {
            onNotifyError(new Error('sns down'), { environment: 'production', version: 4 });
            return Promise.resolve(4);
          },
          rollback: () => Promise.resolve(1),
        }),
      });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/publish', { body: form({ snapshot: VALID }) });

      expect(reply.body).toContain('class="notice success"');
      expect(reply.body).toContain('class="notice warning"');
      expect(reply.body).not.toContain('sns down');
    });

    it('re-renders a rejected draft escaped in the text area with escaped issue lines', async () => {
      const invalid = Object.assign(new Error('bad'), {
        name: 'S3PublishError',
        reason: 'INVALID_SNAPSHOT',
        cause: { issues: [{ path: 'features.<i>', message: 'must be "x"' }] },
      });
      const { ports } = fakes({}, { publish: () => Promise.reject(invalid) });
      const dashboard = await start(ports);
      const draft = '{"features":"</textarea><script>alert(1)</script>"}';

      const reply = await call(dashboard, 'POST', '/env/production/publish', { body: form({ snapshot: draft }) });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The snapshot is not valid.');
      expect(reply.body).toContain('<li>features.&lt;i&gt;: must be &quot;x&quot;</li>');
      expect(reply.body).toContain('&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(reply.body).not.toContain('<script>');
    });

    it('treats a missing snapshot field as invalid JSON without calling the writer', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/publish', { body: '' });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The pasted text is not valid JSON.');
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('rejects a body over the size limit with 413', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/publish', {
        body: form({ snapshot: 'x'.repeat(MAX_BODY_BYTES) }),
      });

      expect(reply.status).toBe(413);
      expect(writer.publish).not.toHaveBeenCalled();
    });
  });

  describe('POST /env/:env/rollback', () => {
    it('rolls back to the submitted version', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/rollback', { body: form({ version: '2' }) });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('Rolled production back to version 2.');
      expect(writer.rollback).toHaveBeenCalledWith('production', 2);
    });

    it('shows a failed rollback as an error notice', async () => {
      const rejected = Object.assign(new Error('no'), { name: 'S3PublishError', reason: 'INVALID_ROLLBACK_TARGET' });
      const { ports } = fakes({}, { rollback: () => Promise.reject(rejected) });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/rollback', { body: form({ version: '2' }) });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('That version cannot be rolled back to');
    });

    it.each([{}, { version: 'two' }])('answers 400 for form %o without calling the writer', async (fields) => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/rollback', { body: form(fields) });

      expect(reply.status).toBe(400);
      expect(writer.rollback).not.toHaveBeenCalled();
    });
  });

  describe('POST /env/:env/features/:key', () => {
    const published = (writer: Fakes['writer']) => writer.publish.mock.calls[0] as [string, Snapshot, unknown];
    type Snapshot = { version: number; createdAt: string; createdBy: string; features: Record<string, Record<string, unknown>> };
    const publishError = (reason: string) => Object.assign(new Error(reason), { name: 'S3PublishError', reason });

    it('publishes the edit against the submitted base version and re-renders with the new version', async () => {
      const fetchSnapshotText = vi.fn(() => Promise.resolve(VALID));
      const { ports, writer } = fakes({ fetchSnapshotText }, { publish: () => Promise.resolve(2) });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '1', field: 'enabled', enabled: 'on' }),
      });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('Published version 2 to production.');
      expect(fetchSnapshotText).toHaveBeenCalledWith('production', 1);
      const [environment, snapshot, options] = published(writer);
      expect(environment).toBe('production');
      expect(options).toEqual({ expectedCurrentVersion: 1 });
      expect(snapshot.version).toBe(2);
      expect(snapshot.createdAt).toBe(NOW.toISOString());
      expect(snapshot.createdBy).toBe('dashboard');
      expect(snapshot.features['new-dashboard']?.enabled).toBe(true);
    });

    it('treats field=enabled without an enabled field as unchecked, meaning false', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'enabled' }),
      });

      expect(published(writer)[1].features['new-dashboard']?.enabled).toBe(false);
    });

    it('publishes an edited config default', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '3', field: 'default', default: '{"max": 5}' }),
      });

      expect(reply.status).toBe(200);
      expect(published(writer)[1].features['checkout-limits']?.default).toEqual({ max: 5 });
    });

    it('URL-decodes the feature key before handing it to the edit', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/a%2Fb', {
        body: form({ baseVersion: '3', field: 'enabled', enabled: 'on' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The snapshot has no feature named &quot;a/b&quot;.');
    });

    it.each([{ field: 'enabled' }, { baseVersion: 'abc', field: 'enabled' }, { baseVersion: '0', field: 'enabled' }])(
      'answers 422 asking for a reload for base version in %o without opening a writer',
      async (fields) => {
        const { ports, openWriter } = fakes();
        const dashboard = await start(ports);

        const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', { body: form(fields) });

        expect(reply.status).toBe(422);
        expect(reply.body).toContain('The edit form is out of date; reload the page and redo your edit.');
        expect(openWriter).not.toHaveBeenCalled();
      },
    );

    it.each([{}, { field: 'rules' }])('answers 422 for a missing or unknown field %o', async (fields) => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', ...fields }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Choose whether to save the enabled flag or the default value.');
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('answers 422 for an unknown feature key', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/missing', {
        body: form({ baseVersion: '3', field: 'enabled', enabled: 'on' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The snapshot has no feature named &quot;missing&quot;.');
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('re-renders invalid default JSON as an escaped draft next to its feature', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '3', field: 'default', default: '</textarea><script>x' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The default value is not valid JSON.');
      expect(reply.body).toContain('<textarea name="default" rows="4">&lt;/textarea&gt;&lt;script&gt;x</textarea>');
      expect(reply.body).not.toContain('<script>x');
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('treats a missing default as empty, invalid JSON', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '3', field: 'default' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The default value is not valid JSON.');
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('keeps the unchecked checkbox in the draft after a failed enabled edit', async () => {
      const { ports } = fakes({}, { publish: () => Promise.reject(publishError('CONFLICT')) });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'enabled' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('<input type="checkbox" name="enabled"> Enabled');
    });

    it('tells the operator to reload and redo the edit when someone else published meanwhile', async () => {
      const { ports, writer } = fakes(
        { readCurrentVersion: () => Promise.resolve(7) },
        { publish: () => Promise.reject(publishError('CONFLICT')) },
      );
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'enabled', enabled: 'on' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Someone else published version 7 meanwhile — reload and redo your edit.');
      expect(published(writer)[2]).toEqual({ expectedCurrentVersion: 3 });
    });

    it('explains the rollback leftover when the next version already exists', async () => {
      const { ports } = fakes({}, { publish: () => Promise.reject(publishError('VERSION_EXISTS')) });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'enabled', enabled: 'on' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Version 4 already exists because of an earlier rollback.');
      expect(reply.body).toContain('paste-publish the snapshot instead');
    });

    it('rejects a foreign Origin, or a foreign Host without Origin, before opening a writer', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);
      const body = form({ baseVersion: '3', field: 'enabled', enabled: 'on' });

      const foreign = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body,
        headers: { origin: 'http://evil.example' },
      });
      const hostOnly = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body,
        sameOrigin: false,
        headers: { host: 'evil.example' },
      });

      expect(foreign.status).toBe(403);
      expect(hostOnly.status).toBe(403);
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('answers 405 to GET and 400 to a malformed key', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const get = await call(dashboard, 'GET', '/env/production/features/new-dashboard');
      expect(get.status).toBe(405);
      expect(get.headers.allow).toBe('POST');

      const malformed = await call(dashboard, 'POST', '/env/production/features/%E0', { body: form({}) });
      expect(malformed.status).toBe(400);
    });
  });

  describe('same-origin check', () => {
    it.each(['publish', 'rollback'])('rejects a foreign Origin on %s before any write', async (action) => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);
      const body = form({ snapshot: VALID, version: '2' });

      for (const origin of ['http://evil.example', 'null', 'http://localhost', 'http://127.0.0.1:1']) {
        const reply = await call(dashboard, 'POST', `/env/production/${action}`, { body, headers: { origin } });
        expect(reply.status).toBe(403);
      }
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('falls back to the Host header when Origin is absent', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);
      const body = form({ version: '2' });

      const foreign = await call(dashboard, 'POST', '/env/production/rollback', {
        body,
        sameOrigin: false,
        headers: { host: 'evil.example' },
      });
      expect(foreign.status).toBe(403);
      expect(writer.rollback).not.toHaveBeenCalled();

      const own = await call(dashboard, 'POST', '/env/production/rollback', { body, sameOrigin: false });
      expect(own.status).toBe(200);
      expect(writer.rollback).toHaveBeenCalledTimes(1);
    });

    it('rejects a POST carrying neither Origin nor Host', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);
      const { port } = new URL(dashboard.url);

      const raw = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.end('POST /env/production/rollback HTTP/1.0\r\nContent-Length: 9\r\n\r\nversion=2');
        });
        let received = '';
        socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
        socket.on('end', () => {
          resolve(received);
        });
        socket.on('error', reject);
      });

      expect(raw).toMatch(/^HTTP\/1\.1 403/);
      expect(openWriter).not.toHaveBeenCalled();
    });
  });

  it.each(['/nope', '/env', '/env/a/b', '/env/a/versions', '/env/a/versions/1/x', '/other/a'])(
    'answers 404 for %s',
    async (path) => {
      const dashboard = await start(fakes().ports);

      expect((await call(dashboard, 'GET', path)).status).toBe(404);
    },
  );

  it.each([
    ['DELETE', '/', 'GET'],
    ['POST', '/env/production', 'GET'],
    ['POST', '/env/production/versions/1', 'GET'],
    ['GET', '/env/production/publish', 'POST'],
    ['PUT', '/env/production/rollback', 'POST'],
  ])('answers 405 for %s %s with Allow: %s', async (method, path, allow) => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, method, path);

    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe(allow);
  });

  it('answers a throwing port with a generic 500 and logs the cause only to the terminal', async () => {
    const secret = new Error('secret-cause');
    const logError = vi.fn();
    const dashboard = await start(fakes({ readCurrentVersion: () => Promise.reject(secret) }).ports, logError);

    const reply = await call(dashboard, 'GET', '/env/production');

    expect(reply.status).toBe(500);
    expect(reply.body).toContain('The request failed unexpectedly');
    expect(reply.body).not.toContain('secret-cause');
    expect(reply.body).not.toContain('at ');
    expect(logError).toHaveBeenCalledWith(secret);
  });

  it('shows the mapped message for a known S3 read failure', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'S3FetchError', reason: 'ACCESS_DENIED' });
    const dashboard = await start(fakes({ readCurrentVersion: () => Promise.reject(denied) }).ports);

    const reply = await call(dashboard, 'GET', '/env/production');

    expect(reply.status).toBe(500);
    expect(reply.body).toContain('Access denied; check the credentials');
  });

  it('logs unexpected errors to console.error by default', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = new Error('secret-cause');
    running = await startDashboardServer({
      ports: fakes({ readCurrentVersion: () => Promise.reject(secret) }).ports,
      port: 0,
    });

    await call(running, 'GET', '/env/production');

    expect(consoleError).toHaveBeenCalledWith(secret);
    consoleError.mockRestore();
  });
});
