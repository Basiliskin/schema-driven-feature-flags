import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotWriter } from '../application/publish-snapshot.js';
import {
  call,
  fakes,
  form,
  publishError,
  snapshotText,
  VALID,
  type Fakes,
} from '../../test/support/dashboard-harness.js';
import {
  decodeAttachValue,
  isAllowedHost,
  MAX_BODY_BYTES,
  startDashboardServer,
  type DashboardPorts,
  type RunningDashboard,
} from './http-server.js';
import { parsePendingChangeSet, serializePendingChangeSet, type PendingChangeSet } from '../domain/pending-change-set.js';

let running: RunningDashboard | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const start = async (ports: DashboardPorts, logError: (error: unknown) => void = vi.fn()) => {
  running = await startDashboardServer({ ports, port: 0, logError });
  return running;
};

type Features = Record<string, Record<string, unknown>>;

/** The hidden field a rendered page hands back, read the way the next request would. */
const pendingOf = (body: string): PendingChangeSet | undefined =>
  parsePendingChangeSet(/name="pending" value="([^"]*)"/.exec(body)?.[1]?.replaceAll('&#39;', "'"));

const featuresOf = (pending: PendingChangeSet | undefined): Features => (pending?.snapshot['features'] ?? {}) as Features;

const DRAFT_FEATURES: Features = {
  'new-dashboard': { type: 'boolean', enabled: false },
  'checkout-limits': { type: 'config', enabled: false, default: { max: 3 } },
};

/** A draft started on `baseVersion` with the given features already staged, as a form would carry it. */
const draftAt = (baseVersion: number, features: Features = DRAFT_FEATURES): PendingChangeSet => ({
  baseVersion,
  snapshot: { ...(JSON.parse(VALID) as Record<string, unknown>), features },
});
const carriedDraft = (draft: PendingChangeSet): string => serializePendingChangeSet(draft);

const submittingForms = (body: string): number => (body.match(/<form\b(?![^>]*method="dialog")/g) ?? []).length;
const pendingFields = (body: string): number => (body.match(/name="pending"/g) ?? []).length;



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

  it('renders a published environment with its flags', async () => {
    const dashboard = await start(fakes().ports);

    const page = await call(dashboard, 'GET', '/env/production');

    expect(page.status).toBe(200);
    expect(page.body).toContain(
      '<span class="flag-key"><a href="/env/production/features/new-dashboard" data-open-flag="new-dashboard">new-dashboard</a></span><span class="badge">boolean</span>',
    );
    expect(page.body).toContain('<code>{&quot;max&quot;:3}</code>');
    expect(page.body).not.toContain('Version history');
    expect(page.body).not.toContain('Restore version');
    expect(page.body).not.toContain('by hand');
  });

  it('renders the empty, invalid, flagless and unavailable current-version states', async () => {
    const empty = await start(fakes({ readCurrentVersion: () => Promise.resolve(undefined) }).ports);
    const emptyPage = await call(empty, 'GET', '/env/staging');
    expect(emptyPage.body).toContain('Nothing has been published to this environment yet.');
    expect(emptyPage.body).not.toContain('by hand');
    await empty.close();

    const invalid = await start(fakes({ fetchSnapshotText: () => Promise.resolve('{"schemaVersion":2}') }).ports);
    expect((await call(invalid, 'GET', '/env/production')).body).toContain('required spellcheck="false"></textarea>');
    await invalid.close();

    const flagless = await start(fakes({ fetchSnapshotText: () => Promise.resolve(snapshotText({})) }).ports);
    expect((await call(flagless, 'GET', '/env/production')).body).toContain('This snapshot defines no flags.');
    await flagless.close();

    const missing = Object.assign(new Error('gone'), { reason: 'SNAPSHOT_NOT_FOUND' });
    const gone = await start(fakes({ fetchSnapshotText: () => Promise.reject(missing) }).ports);
    expect((await call(gone, 'GET', '/env/production')).body).not.toContain('flags-heading');
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
    expect(page.body).toContain('<td data-label="Flag"><code>checkout-limits</code></td>');
    expect(page.body).toContain('<a class="back-link" href="/env/production">Back to production</a>');
    expect(fetchSnapshotText).toHaveBeenCalledWith('production', 2);

    const missing = await call(dashboard, 'GET', '/env/production/versions/9');
    expect(missing.body).toContain('This version is not available in this environment.');
  });

  describe('the version history page', () => {
    it('renders page 1 by default, newest first, with an Older link and no Newer link', async () => {
      const dashboard = await start(fakes({ readCurrentVersion: () => Promise.resolve(45) }).ports);

      const reply = await call(dashboard, 'GET', '/env/production/versions');

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('<h1>production · version history</h1>');
      expect(reply.body).toContain('<a href="/env/production/versions/45">Version 45</a>');
      expect(reply.body).toContain('<a href="/env/production/versions?page=2">Older versions</a>');
      expect(reply.body).not.toContain('Newer versions');
    });

    it('follows its own Older link to the next block of versions', async () => {
      const dashboard = await start(fakes({ readCurrentVersion: () => Promise.resolve(45) }).ports);
      const first = await call(dashboard, 'GET', '/env/production/versions');
      const older = /<a href="([^"]+)">Older versions<\/a>/.exec(first.body);

      const second = await call(dashboard, 'GET', (older?.[1] as string).replace(/&amp;/g, '&'));

      expect(second.status).toBe(200);
      expect(second.body).toContain('<a href="/env/production/versions/25">Version 25</a>');
      expect(second.body).not.toContain('>Version 26<');
      expect(second.body).toContain('Newer versions');
    });

    it('renders an empty-state message and reads no snapshot past the end of the history', async () => {
      const fetchSnapshotText = vi.fn(() => Promise.resolve(VALID));
      const dashboard = await start(fakes({ fetchSnapshotText }).ports);

      const reply = await call(dashboard, 'GET', '/env/production/versions?page=99');

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('There is no version history on this page.');
      expect(fetchSnapshotText).not.toHaveBeenCalled();
    });

    it('shows the single version of a one-version environment with no pager', async () => {
      const dashboard = await start(fakes({ readCurrentVersion: () => Promise.resolve(1) }).ports);

      const reply = await call(dashboard, 'GET', '/env/production/versions');

      expect(reply.body).toContain('<a href="/env/production/versions/1">Version 1</a>');
      expect(reply.body).not.toContain('More version history');
    });

    it('honours an explicit page size', async () => {
      const fetchSnapshotText = vi.fn(() => Promise.resolve(VALID));
      const dashboard = await start(fakes({ readCurrentVersion: () => Promise.resolve(45), fetchSnapshotText }).ports);

      const reply = await call(dashboard, 'GET', '/env/production/versions?pageSize=2');

      expect(fetchSnapshotText).toHaveBeenCalledTimes(2);
      expect(reply.body).toContain('2 per page');
    });

    it.each(['abc', '-1', '0', '1e9', '2.5', ''])('answers 400 for page %s', async (value) => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'GET', `/env/production/versions?page=${encodeURIComponent(value)}`);

      expect(reply.status).toBe(400);
      expect(reply.body).toContain('The page must be a positive integer.');
    });

    it('answers 400 for a malformed page size', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'GET', '/env/production/versions?pageSize=abc');

      expect(reply.status).toBe(400);
      expect(reply.body).toContain('The page size must be a positive integer.');
    });

    it('does not shadow the single-version page', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'GET', '/env/production/versions/2');

      expect(reply.body).toContain('<h1>production · version 2</h1>');
    });
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

  describe('GET /assets/app.js', () => {
    it('serves the page script the pages load, cacheable for good behind its content hash', async () => {
      const dashboard = await start(fakes().ports);

      const page = await call(dashboard, 'GET', '/env/production');
      const src = /<script src="([^"]+)" defer><\/script>/.exec(page.body)?.[1] as string;
      const script = await call(dashboard, 'GET', src);

      expect(src).toMatch(/^\/assets\/app\.js\?v=[0-9a-f]{12}$/);
      expect(script.status).toBe(200);
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(script.body).toContain('/current-version');
    });
  });

  describe('update checks', () => {
    const versioned = (current: number) =>
      fakes({
        readCurrentVersion: () => Promise.resolve(current),
        fetchSnapshotText: (_env, version) =>
          Promise.resolve(
            version === 3
              ? VALID
              : snapshotText({
                  'new-dashboard': { type: 'boolean', enabled: false },
                  'dark-mode': { type: 'boolean', enabled: true },
                }),
          ),
      });

    it('marks the page with the version it was rendered from', async () => {
      const dashboard = await start(fakes().ports);
      const page = await call(dashboard, 'GET', '/env/production');
      expect(page.body).toContain('data-watch-version="3" data-watch-path="/env/production"');
      expect(page.body).toContain('<div id="update-banner" class="update-banner" role="status" hidden>');
    });

    it('reports the current version as uncached JSON', async () => {
      const dashboard = await start(versioned(5).ports);
      const reply = await call(dashboard, 'GET', '/env/production/current-version');
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(reply.body)).toEqual({ version: 5 });
    });

    it('reports null for an environment with nothing published', async () => {
      const dashboard = await start(fakes({ readCurrentVersion: () => Promise.resolve(undefined) }).ports);
      expect(JSON.parse((await call(dashboard, 'GET', '/env/production/current-version')).body)).toEqual({ version: null });
    });

    it('renders the flag-level changes since a version for the review dialog', async () => {
      const dashboard = await start(versioned(5).ports);
      const reply = await call(dashboard, 'GET', '/env/production/changes?since=3');
      expect(reply.status).toBe(200);
      expect(reply.body).toContain('From version 3 to version 5, published by test');
      expect(reply.body).toContain('<li data-changed-key="checkout-limits">');
      expect(reply.body).toContain('<span class="badge diff-removed">removed</span>');
      expect(reply.body).toContain('<li data-changed-key="dark-mode">');
      expect(reply.body).toContain('<th scope="row">enabled</th><td class="diff-before"><code>true</code></td><td class="diff-after"><code>false</code></td>');
      expect(reply.body).toContain('data-merge="keep"');
    });

    it('flags the rejected edit on its row, and explains when that flag was deleted', async () => {
      const dashboard = await start(versioned(5).ports);
      const deleted = await call(dashboard, 'GET', '/env/production/changes?since=3&edited=checkout-limits');
      expect(deleted.body).toContain('<li data-changed-key="checkout-limits" class="has-conflict">');
      expect(deleted.body).toContain('This flag was deleted, so your edit to it can’t be applied.');
      const changed = await call(dashboard, 'GET', '/env/production/changes?since=3&edited=new-dashboard');
      expect(changed.body).toContain('Your edit to this flag is kept in its form');
    });

    it('says so when nothing changed, and rejects a bad since', async () => {
      const dashboard = await start(versioned(3).ports);
      expect((await call(dashboard, 'GET', '/env/production/changes?since=3')).body).toContain('already have the latest');
      expect((await call(dashboard, 'GET', '/env/production/changes?since=x')).status).toBe(400);
    });
  });

  describe('POST /env/:env/merge', () => {
    const limits = (enabled: boolean, max: unknown) => ({ type: 'config', enabled, default: { max } });
    const base = snapshotText({ a: { type: 'boolean', enabled: true }, b: limits(true, 1) });
    const latest = snapshotText({ a: { type: 'boolean', enabled: false }, b: limits(true, 9) });
    const draft = snapshotText({ a: { type: 'boolean', enabled: true }, b: limits(false, '</script>') });
    const ports = () =>
      fakes({
        readCurrentVersion: () => Promise.resolve(5),
        fetchSnapshotText: (_env, version) => Promise.resolve(version === 3 ? base : latest),
      }).ports;

    it('preselects one-sided changes and asks only about fields changed differently on both sides', async () => {
      const dashboard = await start(ports());
      const reply = await call(dashboard, 'POST', '/env/production/merge', { body: form({ since: '3', snapshot: draft }) });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('<strong>1 flag was changed on both sides</strong>');
      expect(reply.body).toContain('<input type="radio" name="pick:a" value="theirs" checked> Take version 5');
      expect(reply.body).toContain('<li data-merge-key="b" data-by-field class="merge-conflict">');
      expect(reply.body).toContain('<div class="merge-field merge-conflict" data-merge-field="default">');
      expect(reply.body).toContain('<input type="radio" name="pick:b:default" value="mine"> Keep mine');
      expect(reply.body).toContain('<input type="radio" name="pick:b:default" value="theirs"> Take version 5');
      expect(reply.body).toContain('<input type="radio" name="pick:b:enabled" value="mine" checked> Keep mine');
      expect(reply.body).not.toContain('data-merge-field="type"');
    });

    it('applies the choices on the server and returns the merged draft', async () => {
      const dashboard = await start(ports());
      const reply = await call(dashboard, 'POST', '/env/production/merge/apply', {
        body: form({ since: '3', to: '5', snapshot: draft, choices: JSON.stringify({ b: { default: 'theirs' } }) }),
      });

      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
      const result = JSON.parse(reply.body) as { status: string; snapshotText: string };
      expect(result.status).toBe('merged');
      expect((JSON.parse(result.snapshotText) as { features: unknown }).features).toEqual({
        a: { type: 'boolean', enabled: false },
        b: { type: 'config', enabled: false, default: { max: 9 } },
      });
    });

    it('answers 409 naming the conflicts still without a choice, or a version that moved', async () => {
      const dashboard = await start(ports());
      const missing = await call(dashboard, 'POST', '/env/production/merge/apply', {
        body: form({ since: '3', to: '5', snapshot: draft, choices: '{}' }),
      });
      expect(missing.status).toBe(409);
      expect(JSON.parse(missing.body)).toEqual({ status: 'missing', missing: ['b.default'] });

      const moved = await call(dashboard, 'POST', '/env/production/merge/apply', {
        body: form({ since: '3', to: '4', snapshot: draft, choices: '{}' }),
      });
      expect(JSON.parse(moved.body)).toEqual({ status: 'moved', to: 5 });
    });

    it('treats missing fields as an empty draft and no choices', async () => {
      const dashboard = await start(ports());
      const merge = await call(dashboard, 'POST', '/env/production/merge', { body: form({ since: '3' }) });
      expect(merge.body).toContain('can’t be merged');
      const apply = await call(dashboard, 'POST', '/env/production/merge/apply', { body: form({ since: '3', to: '5' }) });
      expect(JSON.parse(apply.body)).toEqual({ status: 'invalid-draft' });
    });

    it('rejects malformed choices with 400', async () => {
      const dashboard = await start(ports());
      for (const choices of ['{', '[]', '{"b":"both"}', '{"b":{"default":1}}']) {
        const reply = await call(dashboard, 'POST', '/env/production/merge/apply', {
          body: form({ since: '3', to: '5', snapshot: draft, choices }),
        });
        expect(reply.status).toBe(400);
      }
    });

    it('explains a draft that cannot be merged', async () => {
      const dashboard = await start(ports());
      const reply = await call(dashboard, 'POST', '/env/production/merge', { body: form({ since: '3', snapshot: '{' }) });
      expect(reply.body).toContain('can’t be merged');
    });

    it('requires a same-origin POST', async () => {
      const dashboard = await start(ports());
      expect((await call(dashboard, 'GET', '/env/production/merge')).status).toBe(405);
      const foreign = await call(dashboard, 'POST', '/env/production/merge', { body: form({ since: '3', snapshot: draft }), sameOrigin: false });
      expect(foreign.status).toBe(403);
    });
  });

  describe('GET /assets/app.css', () => {
    it('serves the one stylesheet the pages link, cacheable for good behind its content hash', async () => {
      const dashboard = await start(fakes().ports);

      const page = await call(dashboard, 'GET', '/env/production');
      const href = /<link rel="stylesheet" href="([^"]+)">/.exec(page.body)?.[1] as string;
      const sheet = await call(dashboard, 'GET', href);

      expect(href).toMatch(/^\/assets\/app\.css\?v=[0-9a-f]{12}$/);
      expect(sheet.status).toBe(200);
      expect(sheet.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(sheet.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(sheet.headers['x-content-type-options']).toBe('nosniff');
      expect(sheet.body).toContain('@media (prefers-color-scheme: dark)');
      expect(sheet.body).toContain('@media (max-width: 640px)');
      expect(sheet.body.indexOf('--bg:')).toBeLessThan(sheet.body.indexOf('.flag-table'));
    });

    it('accepts GET only and has no other assets', async () => {
      const dashboard = await start(fakes().ports);

      const post = await call(dashboard, 'POST', '/assets/app.css', { body: '' });
      expect(post.status).toBe(405);
      expect(post.headers.allow).toBe('GET');
      expect((await call(dashboard, 'GET', '/assets/other.css')).status).toBe(404);
      expect((await call(dashboard, 'GET', '/assets/app.css/x')).status).toBe(404);
    });
  });

  it('publishes the pre-filled publish box unchanged as a new version with the same features', async () => {
    const { ports, writer } = fakes();
    const dashboard = await start(ports);

    const page = await call(dashboard, 'GET', '/env/production');
    const prefilled = /<textarea id="snapshot"[^>]*>([^<]*)<\/textarea>/.exec(page.body)?.[1] as string;
    const text = prefilled.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    const reply = await call(dashboard, 'POST', '/env/production/publish', { body: form({ snapshot: text }) });

    expect(reply.status).toBe(200);
    const published = writer.publish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(published).not.toHaveProperty('version');
    expect(published).not.toHaveProperty('previousVersion');
    expect(published).not.toHaveProperty('createdAt');
    expect(published.features).toEqual((JSON.parse(VALID) as Record<string, unknown>).features);
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

    expect(page.body).not.toContain('<script>"');
    expect(page.body).toContain('<li>features.x&quot;&amp;&lt;y: ');
    expect(version.body).not.toContain('<b>');
    expect(version.body).toContain('<code>&quot;&lt;b&gt;\\&quot;&amp;&lt;/b&gt;&quot;</code>');
    expect(page.body).toContain('href="/env/%3Cscript%3E%22\'/versions"'.replace("'", '&#39;'));
  });

  describe('POST /env/:env/publish', () => {
    it('publishes against the version the page showed, carried in the form', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const page = await call(dashboard, 'GET', '/env/production');
      expect(page.body).toMatch(/action="\/env\/production\/publish" class="stack">\n<input type="hidden" name="baseVersion" value="3">/);

      await call(dashboard, 'POST', '/env/production/publish', { body: form({ baseVersion: '3', snapshot: VALID }) });
      expect(writer.publish).toHaveBeenCalledWith('production', JSON.parse(VALID), { expectedCurrentVersion: 3 });
    });

    it('turns a lost race into a reviewable conflict instead of reopening the draft', async () => {
      const { ports } = fakes(
        { readCurrentVersion: () => Promise.resolve(5) },
        { publish: () => Promise.reject(publishError('CONFLICT')) },
      );
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/publish', { body: form({ baseVersion: '3', snapshot: VALID }) });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Someone else published version 5 meanwhile, so your edit was not saved.');
      expect(reply.body).toContain('data-watch-version="5" data-watch-path="/env/production" data-review-since="3" hidden>');
      expect(reply.body).toContain('Your snapshot draft was based on version 3');
      expect(reply.body).toContain('<dialog id="publish-dialog" class="modal-dialog" aria-labelledby="publish-heading">');
      expect(reply.body).toContain('<input type="hidden" name="baseVersion" value="5">');
    });

    it('publishes the pasted JSON through a writer opened for this request', async () => {
      const { ports, writer, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/publish', { body: form({ snapshot: VALID }) });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('Published version 4 to production.');
      // After a successful publish the box is pre-filled from the new current snapshot, not the old draft.
      expect(reply.body).toContain('&quot;features&quot;: {');
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
      expect(reply.body).not.toContain('<script>alert(1)');
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
      expect(reply.body).toContain('Restored version 2 of production as version 2.');
      expect(writer.rollback).toHaveBeenCalledWith('production', 2, { actor: 'dashboard' });
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

  describe('POST /env/:env/features', () => {
    const published = (writer: Fakes['writer']) =>
      writer.publish.mock.calls[0] as [string, { features: Record<string, unknown> }, unknown];

    it('creates a boolean flag against the submitted base version', async () => {
      const { ports, writer } = fakes({}, { publish: () => Promise.resolve(4) });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', key: 'beta', type: 'boolean', enabled: 'on', default: 'ignored' }),
      });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('Published version 4 to production.');
      const [environment, snapshot, options] = published(writer);
      expect(environment).toBe('production');
      expect(options).toEqual({ expectedCurrentVersion: 3 });
      expect(snapshot.features.beta).toEqual({ type: 'boolean', enabled: true });
      expect(Object.keys(snapshot.features)).toEqual(['new-dashboard', 'checkout-limits', 'beta']);
    });

    it('creates a disabled config flag with its default', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', key: 'limits', type: 'config', default: '{"max":2}' }),
      });

      expect(published(writer)[1].features.limits).toEqual({ type: 'config', enabled: false, default: { max: 2 } });
    });

    it.each<[string, Record<string, string>, string]>([
      ['a duplicate key', { key: 'new-dashboard', type: 'boolean' }, 'A feature named &quot;new-dashboard&quot; already exists'],
      ['an invalid key', { key: 'bad/key', type: 'boolean' }, '&quot;bad/key&quot; is not a valid feature key'],
      ['a missing key', { type: 'boolean' }, '&quot;&quot; is not a valid feature key'],
      ['a malformed default', { key: 'limits', type: 'config', default: '{' }, 'The default value is not valid JSON.'],
      ['a missing default', { key: 'limits', type: 'config' }, 'The default value is not valid JSON.'],
      ['an unknown type', { key: 'limits', type: 'number' }, 'Choose whether the new flag is a boolean or a config flag.'],
      ['a missing base version', { key: 'limits', type: 'boolean', baseVersion: '' }, 'The edit form is out of date'],
    ])('answers 422 for %s, keeping the draft and writing nothing', async (_, fields, message) => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', ...fields }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain(message);
      expect(reply.body).toContain(`name="key" required value="${fields.key ?? ''}"`);
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('keeps the chosen config type, checkbox and default text in the draft', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', key: 'limits', type: 'config', enabled: 'on', default: '</textarea>' }),
      });

      expect(reply.body).toContain('<option value="config" selected>config</option>');
      expect(reply.body).toContain('<input type="checkbox" name="enabled" checked> Enabled');
      expect(reply.body).toContain('<textarea name="default" rows="3">&lt;/textarea&gt;</textarea>');
    });

    it('reports a stale base version as a conflict, not an overwrite', async () => {
      const { ports, writer } = fakes(
        { readCurrentVersion: () => Promise.resolve(5) },
        { publish: () => Promise.reject(publishError('CONFLICT')) },
      );
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', key: 'beta', type: 'boolean' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Someone else published version 5 meanwhile, so your edit was not saved.');
      expect(published(writer)[2]).toEqual({ expectedCurrentVersion: 3 });
    });

    it('rejects a missing Origin with 403 and answers GET with 405', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const post = await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', key: 'beta', type: 'boolean' }),
        sameOrigin: false,
      });
      const get = await call(dashboard, 'GET', '/env/production/features');

      expect(post.status).toBe(403);
      expect(get.status).toBe(405);
      expect(get.headers.allow).toBe('POST');
      expect(openWriter).not.toHaveBeenCalled();
    });
  });

  describe('POST /env/:env/features/:key', () => {
    const published = (writer: Fakes['writer']) => writer.publish.mock.calls[0] as [string, Snapshot, unknown];
    type Snapshot = { version: number; createdAt: string; createdBy: string; features: Record<string, Record<string, unknown>> };

    it('stages the edit into a Pending Change Set instead of publishing a version', async () => {
      const { ports, writer, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'save' }),
      });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('Staged.');
      expect(reply.body).toContain('data-watch-version="3"');
      expect(openWriter).not.toHaveBeenCalled();
      expect(writer.publish).not.toHaveBeenCalled();
      const pending = pendingOf(reply.body);
      expect(pending?.baseVersion).toBe(3);
      expect(featuresOf(pending)['new-dashboard']?.enabled).toBe(false);
    });

    it('stages a checked enabled box as true', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '3', field: 'save', enabled: 'on' }),
      });

      expect(featuresOf(pendingOf(reply.body))['checkout-limits']?.enabled).toBe(true);
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('stages an edited config default', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '3', field: 'save', default: '{"max": 5}' }),
      });

      expect(reply.status).toBe(200);
      expect(featuresOf(pendingOf(reply.body))['checkout-limits']?.default).toEqual({ max: 5 });
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('accumulates a second staged edit onto the draft the form carried, keeping its Base Version', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);
      const earlier = draftAt(2);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '2', field: 'save', default: '{"max": 5}', pending: carriedDraft(earlier) }),
      });

      const pending = pendingOf(reply.body);
      expect(pending?.baseVersion).toBe(2);
      expect(featuresOf(pending)['new-dashboard']?.enabled).toBe(false);
      expect(featuresOf(pending)['checkout-limits']?.default).toEqual({ max: 5 });
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('answers a draft it cannot read as if nothing were staged', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'save', pending: '%E0%A4%A' }),
      });

      expect(reply.status).toBe(200);
      expect(pendingOf(reply.body)?.baseVersion).toBe(3);
    });

    it('URL-decodes the feature key before handing it to the edit', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/a%2Fb', {
        body: form({ baseVersion: '3', field: 'save', enabled: 'on' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The snapshot has no feature named &quot;a/b&quot;.');
    });

    it.each([{ field: 'save' }, { baseVersion: 'abc', field: 'save' }, { baseVersion: '0', field: 'save' }])(
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

    it.each([{}, { field: 'nonsense' }])('answers 422 for a missing or unknown field %o', async (fields) => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', ...fields }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Choose one of these actions: save, delete.');
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('answers 422 for an unknown feature key', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/missing', {
        body: form({ baseVersion: '3', field: 'save', enabled: 'on' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The snapshot has no feature named &quot;missing&quot;.');
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('re-renders invalid default JSON as an escaped draft next to its feature', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '3', field: 'save', default: '</textarea><script>x' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The default value is not valid JSON.');
      expect(reply.body).toContain('<textarea name="default" rows="4">&lt;/textarea&gt;&lt;script&gt;x</textarea>');
      expect(reply.body).not.toContain('<script>x');
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('treats an emptied default textarea as invalid JSON, not as leaving the default alone', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '3', field: 'save', default: '' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('The default value is not valid JSON.');
      expect(openWriter).not.toHaveBeenCalled();
    });

    // A boolean flag's form never renders a `default` field at all (see feature-edit-form.ts), so its
    // absence from the POST body is what tells Save to leave the default untouched, not an error.
    it('leaves a boolean flag alone when the request carries no default field, since its form never renders one', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'save' }),
      });

      expect(reply.status).toBe(200);
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('keeps the checked box in the draft when a staged enabled edit is rejected, and hands the earlier draft back', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);
      const earlier = draftAt(2, { 'new-dashboard': { type: 'boolean', enabled: false } });

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout-limits', {
        body: form({ baseVersion: '2', field: 'save', enabled: 'on', pending: carriedDraft(earlier) }),
      });

      expect(reply.status).toBe(422);
      const row = reply.body.slice(reply.body.indexOf('data-flag="checkout-limits"'));
      expect(/<input type="checkbox" name="enabled"( checked)?> Enabled/.exec(row)?.[1]).toBe(' checked');
      expect(pendingOf(reply.body)).toEqual(earlier);
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('tells the operator to reload and redo the edit when someone else published meanwhile', async () => {
      const { ports, writer } = fakes(
        { readCurrentVersion: () => Promise.resolve(7) },
        { publish: () => Promise.reject(publishError('CONFLICT')) },
      );
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Someone else published version 7 meanwhile, so your edit was not saved.');
      expect(published(writer)[2]).toEqual({ expectedCurrentVersion: 3 });
    });

    it('offers to review what changed since the version the rejected edit was made on', async () => {
      const { ports } = fakes(
        { readCurrentVersion: () => Promise.resolve(7) },
        { publish: () => Promise.reject(publishError('CONFLICT')) },
      );
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete' }),
      });

      expect(reply.body).toContain('data-watch-version="7" data-watch-path="/env/production" data-review-since="3" data-review-key="new-dashboard"');
      expect(reply.body).toContain('<div id="update-banner" class="update-banner" role="status">');
      expect(reply.body).toContain('Your edit to <code>new-dashboard</code> was made on version 3');
    });

    it('does not offer a review for failures that are not conflicts', async () => {
      const dashboard = await start(fakes().ports);
      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'save', default: '{' }),
      });
      expect(reply.body).not.toContain('data-review-since');
      expect(reply.body).toContain('<div id="update-banner" class="update-banner" role="status" hidden>');
    });

    it('treats a taken next version as a concurrent publish', async () => {
      const { ports } = fakes({}, { publish: () => Promise.reject(publishError('VERSION_EXISTS')) });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('meanwhile, so your edit was not saved.');
      expect(reply.body).not.toContain('paste-publish');
    });

    it('deletes a feature and publishes the snapshot without it', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete' }),
      });

      expect(reply.status).toBe(200);
      const [, snapshot, options] = published(writer);
      expect(options).toEqual({ expectedCurrentVersion: 3 });
      expect(Object.keys(snapshot.features)).toEqual(['checkout-limits']);
    });

    // Raw rules-JSON editing is no longer exposed through the dashboard's one Save button; a rule's
    // rollout, its segment and its detach are staged instead through the structured rollout fields
    // (see "rollout edits on POST /env/:env/features/:key" below). applyFlagEdit's own `setRules` kind
    // and its validation stay covered at the domain layer (flag-edit.test.ts).

    it('reports a stale base version on delete as a conflict, not an overwrite', async () => {
      const { ports } = fakes(
        { readCurrentVersion: () => Promise.resolve(5) },
        { publish: () => Promise.reject(publishError('CONFLICT')) },
      );
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete' }),
      });

      expect(reply.status).toBe(422);
      expect(reply.body).toContain('Someone else published version 5 meanwhile, so your edit was not saved.');
    });

    it('rejects a foreign Origin, or a missing Origin, before opening a writer', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);
      const body = form({ baseVersion: '3', field: 'save', enabled: 'on' });

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

    it('answers 405 to a verb the address does not accept and 400 to a malformed key', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const deleted = await call(dashboard, 'DELETE', '/env/production/features/new-dashboard');
      expect(deleted.status).toBe(405);
      expect(deleted.headers.allow).toBe('GET, POST');

      const malformed = await call(dashboard, 'POST', '/env/production/features/%E0', { body: form({}) });
      expect(malformed.status).toBe(400);
    });
  });

  describe('a staged draft next to the surfaces that still publish at once', () => {
    const published = (writer: Fakes['writer']) => writer.publish.mock.calls[0] as [string, { features: Features }, unknown];

    it('still publishes a created flag and bumps the version by one, leaving the draft unpublished and echoed', async () => {
      const { ports, writer } = fakes({}, { publish: () => Promise.resolve(4) });
      const dashboard = await start(ports);
      const draft = draftAt(2);

      const reply = await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', key: 'beta', type: 'boolean', pending: carriedDraft(draft) }),
      });

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('Published version 4 to production.');
      expect(writer.publish).toHaveBeenCalledTimes(1);
      expect(Object.keys(published(writer)[1].features)).toEqual(['new-dashboard', 'checkout-limits', 'beta']);
      expect(published(writer)[1].features['new-dashboard']?.enabled).toBe(true);
      expect(pendingOf(reply.body)).toEqual(draft);
    });

    it('still publishes a delete at once, and hands the draft back', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);
      const draft = draftAt(2);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete', pending: carriedDraft(draft) }),
      });

      expect(reply.status).toBe(200);
      expect(writer.publish).toHaveBeenCalledTimes(1);
      expect(Object.keys(published(writer)[1].features)).toEqual(['checkout-limits']);
      expect(pendingOf(reply.body)).toEqual(draft);
    });

    it.each([
      ['a page load', 'GET', (draft: string) => `/env/production?${new URLSearchParams({ pending: draft }).toString()}`, undefined],
      ['a pasted publish', 'POST', () => '/env/production/publish', { snapshot: VALID, baseVersion: '3' }],
      ['a rollback', 'POST', () => '/env/production/rollback', { version: '2' }],
    ] as const)('hands the draft back through %s in every form on the page', async (_label, method, path, fields) => {
      const dashboard = await start(fakes().ports);
      const draft = draftAt(2);
      const carried = carriedDraft(draft);

      const reply = await call(dashboard, method, path(carried), {
        ...(fields === undefined ? {} : { body: form({ ...fields, pending: carried }) }),
      });

      expect(pendingOf(reply.body)).toEqual(draft);
      expect(submittingForms(reply.body)).toBeGreaterThanOrEqual(6);
      expect(pendingFields(reply.body)).toBe(submittingForms(reply.body));
    });

    it('hands the draft back in every form after a created flag and a delete as well', async () => {
      const dashboard = await start(fakes().ports);
      const carried = carriedDraft(draftAt(2));

      const created = await call(dashboard, 'POST', '/env/production/features', {
        body: form({ baseVersion: '3', key: 'beta', type: 'boolean', pending: carried }),
      });
      const deleted = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete', pending: carried }),
      });

      for (const reply of [created, deleted]) {
        expect(pendingFields(reply.body)).toBe(submittingForms(reply.body));
      }
    });

    it('renders no pending field when nothing is staged', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'GET', '/env/production');

      expect(reply.body).not.toContain('name="pending"');
    });
  });

  describe('POST /env/:env/pending', () => {
    /** A store whose current version moves only when the fake writer publishes, so version deltas are observable. */
    const store = (startAt: number) => {
      let version = startAt;
      const { ports, writer, openWriter } = fakes(
        { readCurrentVersion: () => Promise.resolve(version) },
        { publish: () => Promise.resolve(++version) },
      );
      return { ports, writer, openWriter, version: () => version, moveTo: (next: number) => (version = next) };
    };
    const staged = (baseVersion: number) =>
      draftAt(baseVersion, { 'new-dashboard': { type: 'boolean', enabled: false, rules: [] } });
    const submit = (dashboard: Awaited<ReturnType<typeof start>>, fields: Record<string, string>) =>
      call(dashboard, 'POST', '/env/production/pending', { body: form(fields) });
    const reviewDialogOf = (body: string): string => {
      const start = body.indexOf('<dialog id="review-dialog"');
      return start === -1 ? '' : body.slice(start, body.indexOf('</dialog>', start));
    };

    it('opens the Review Dialog on load right after an edit is staged, listing the net change', async () => {
      const { ports } = store(3);
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'save' }),
      });

      const dialog = reviewDialogOf(reply.body);
      expect(dialog).toContain('data-open-on-load');
      expect(dialog).toContain('<span class="flag-key">new-dashboard</span><span class="badge diff-changed">changed</span>');
      expect(dialog).toContain('<button type="submit" name="field" value="update">Update</button>');
      expect(dialog).not.toContain('data-version-drift');
    });

    it('does not open it on load after an immediate-publish write that merely carried the draft', async () => {
      const { ports } = store(3);
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/new-dashboard', {
        body: form({ baseVersion: '3', field: 'delete', pending: carriedDraft(staged(3)) }),
      });

      expect(reviewDialogOf(reply.body)).not.toContain('data-open-on-load');
      expect(reply.body).toContain('<dialog id="review-dialog"');
    });

    it('Update publishes the whole draft as exactly one new version, expecting its base, and clears the draft', async () => {
      const { ports, writer, version } = store(3);
      const dashboard = await start(ports);
      const before = version();

      const reply = await submit(dashboard, { field: 'update', pending: carriedDraft(staged(3)) });

      expect(reply.status).toBe(200);
      expect(version() - before).toBe(1);
      expect(writer.publish).toHaveBeenCalledTimes(1);
      const [environment, snapshot, options] = writer.publish.mock.calls[0] as [string, { features: Features }, unknown];
      expect(environment).toBe('production');
      expect(snapshot.features['new-dashboard']?.enabled).toBe(false);
      expect(options).toEqual({ expectedCurrentVersion: 3 });
      expect(reply.body).toContain('Published version 4 to production.');
      expect(reply.body).toContain('data-watch-version="4"');
      expect(reply.body).not.toContain('name="pending"');
      expect(reply.body).not.toContain('review-dialog');
    });

    it('a second Update after a successful one has no draft to publish', async () => {
      const { ports, writer } = store(3);
      const dashboard = await start(ports);
      const first = await submit(dashboard, { field: 'update', pending: carriedDraft(staged(3)) });

      expect(pendingOf(first.body)).toBeUndefined();
      const second = await submit(dashboard, { field: 'update' });

      expect(second.status).toBe(400);
      expect(writer.publish).toHaveBeenCalledTimes(1);
    });

    it('Discard changes nothing in storage and the response no longer carries the draft', async () => {
      const { ports, writer, openWriter, version } = store(3);
      const dashboard = await start(ports);

      const reply = await submit(dashboard, { field: 'discard', pending: carriedDraft(staged(3)) });

      expect(reply.status).toBe(200);
      expect(version()).toBe(3);
      expect(openWriter).not.toHaveBeenCalled();
      expect(writer.publish).not.toHaveBeenCalled();
      expect(reply.body).toContain('Discarded your pending changes.');
      expect(reply.body).not.toContain('name="pending"');
      expect(reply.body).not.toContain('review-dialog');
    });

    it('shows a drift warning with a still-working publish-anyway button once the environment moved on', async () => {
      const { ports } = store(5);
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'GET', `/env/production?${new URLSearchParams({ pending: carriedDraft(staged(3)) }).toString()}`);

      const dialog = reviewDialogOf(reply.body);
      expect(dialog).toContain('data-version-drift');
      expect(dialog).toContain('<button type="submit" name="field" value="publishAnyway">Publish anyway</button>');
      expect(dialog).not.toContain('disabled');
      expect(dialog).not.toContain('data-open-on-load');
    });

    it('publish anyway publishes one new version without expecting the base', async () => {
      const { ports, writer, version } = store(5);
      const dashboard = await start(ports);

      const reply = await submit(dashboard, { field: 'publishAnyway', pending: carriedDraft(staged(3)) });

      expect(reply.status).toBe(200);
      expect(version()).toBe(6);
      expect(writer.publish).toHaveBeenCalledTimes(1);
      expect(writer.publish.mock.calls[0]).toHaveLength(2);
      expect(reply.body).toContain('Published version 6 to production.');
      expect(reply.body).not.toContain('name="pending"');
    });

    it('an Update from a stale page fails as a conflict, keeps the draft and reopens the dialog with the drift warning', async () => {
      const { ports, writer } = store(5);
      writer.publish.mockRejectedValueOnce(publishError('CONFLICT'));
      const dashboard = await start(ports);
      const draft = staged(3);

      const reply = await submit(dashboard, { field: 'update', pending: carriedDraft(draft) });

      expect(reply.status).toBe(422);
      expect(writer.publish).toHaveBeenCalledTimes(1);
      expect(reply.body).toContain('Someone else published version 5 meanwhile, so your edit was not saved.');
      expect(pendingOf(reply.body)).toEqual(draft);
      const dialog = reviewDialogOf(reply.body);
      expect(dialog).toContain('data-open-on-load');
      expect(dialog).toContain('data-version-drift');
    });

    it.each([
      ['an unknown action', { field: 'republish' }],
      ['a prototype key', { field: 'constructor' }],
      ['no action', {}],
    ] as const)('publishes nothing for %s and hands the draft back', async (_label, fields) => {
      const { ports, writer, openWriter } = store(3);
      const dashboard = await start(ports);
      const draft = staged(3);

      const reply = await submit(dashboard, { ...fields, pending: carriedDraft(draft) });

      expect(reply.status).toBe(400);
      expect(reply.body).toContain('Choose one of these actions: update, publishAnyway, discard.');
      expect(openWriter).not.toHaveBeenCalled();
      expect(writer.publish).not.toHaveBeenCalled();
      expect(pendingOf(reply.body)).toEqual(draft);
    });

    it.each([
      ['no draft is carried', { field: 'update' }],
      ['the carried draft is malformed', { field: 'update', pending: '%E0%A4%A' }],
    ] as const)('refuses an action when %s', async (_label, fields) => {
      const { ports, writer } = store(3);
      const dashboard = await start(ports);

      const reply = await submit(dashboard, fields);

      expect(reply.status).toBe(400);
      expect(reply.body).toContain('There are no pending changes to review; stage an edit first.');
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('only accepts POST from the dashboard’s own pages', async () => {
      const { ports, openWriter } = store(3);
      const dashboard = await start(ports);

      const foreign = await call(dashboard, 'POST', '/env/production/pending', {
        body: form({ field: 'update', pending: carriedDraft(staged(3)) }),
        sameOrigin: false,
      });
      const get = await call(dashboard, 'GET', '/env/production/pending');

      expect(foreign.status).toBe(403);
      expect(get.status).toBe(405);
      expect(openWriter).not.toHaveBeenCalled();
    });
  });

  describe('GET /env/:env/features/:key', () => {
    it('renders the flag on its own page', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'GET', '/env/production/features/new-dashboard');

      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(reply.body).toContain('<h1>new-dashboard</h1>');
      expect(reply.body).toContain('action="/env/production/features/new-dashboard"');
    });

    it('answers 404 with the error page when the snapshot does not define the key', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'GET', '/env/production/features/does-not-exist');

      expect(reply.status).toBe(404);
      expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(reply.body).toContain('does-not-exist');
    });

    it('answers 404 when the environment has nothing published', async () => {
      const { ports } = fakes({ readCurrentVersion: () => Promise.resolve(undefined) });
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'GET', '/env/production/features/new-dashboard');

      expect(reply.status).toBe(404);
      expect(reply.body).toContain('new-dashboard');
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

    it.each(['publish', 'rollback'])('rejects %s without an Origin, even from its own Host', async (action) => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', `/env/production/${action}`, {
        body: form({ snapshot: VALID, version: '2' }),
        sameOrigin: false,
      });

      expect(reply.status).toBe(403);
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('accepts the dashboard’s own Origin', async () => {
      const { ports, writer } = fakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/rollback', { body: form({ version: '2' }) });

      expect(reply.status).toBe(200);
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

  describe('Host allowlist', () => {
    it.each(['127.0.0.1:4000', 'localhost:4000', 'LOCALHOST:4000'])('accepts %s', (host) => {
      expect(isAllowedHost(host, 4000)).toBe(true);
    });

    it.each([
      undefined,
      '',
      'localhost',
      'localhost:4001',
      '127.0.0.1:4001',
      '[::1]:4000',
      'evil.example:4000',
      'localhost.evil.example:4000',
      '127.0.0.1.nip.io:4000',
    ])('rejects %s', (host) => {
      expect(isAllowedHost(host, 4000)).toBe(false);
    });

    it.each(['/', '/env/production', '/env/production/versions/1'])(
      'refuses GET %s under a foreign Host with plain text',
      async (path) => {
        const { ports } = fakes();
        const dashboard = await start(ports);
        const { port } = new URL(dashboard.url);

        const reply = await call(dashboard, 'GET', path, { headers: { host: `evil.example:${port}` } });

        expect(reply.status).toBe(403);
        expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(reply.body).not.toContain('<');
      },
    );

    it('refuses GET on the right host but the wrong port', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);
      const { port } = new URL(dashboard.url);

      const reply = await call(dashboard, 'GET', '/', { headers: { host: `127.0.0.1:${String(Number(port) + 1)}` } });

      expect(reply.status).toBe(403);
    });

    it('serves GET addressed to localhost on its own port', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);
      const { port } = new URL(dashboard.url);

      const reply = await call(dashboard, 'GET', '/', { headers: { host: `localhost:${port}` } });

      expect(reply.status).toBe(200);
    });

    it('refuses a POST with its own Origin but a foreign Host', async () => {
      const { ports, openWriter } = fakes();
      const dashboard = await start(ports);
      const { port } = new URL(dashboard.url);

      const reply = await call(dashboard, 'POST', '/env/production/rollback', {
        body: form({ version: '2' }),
        headers: { host: `proxy.example:${port}` },
      });

      expect(reply.status).toBe(403);
      expect(openWriter).not.toHaveBeenCalled();
    });

    it('refuses a GET with no Host header', async () => {
      const { ports } = fakes();
      const dashboard = await start(ports);
      const { port } = new URL(dashboard.url);

      const raw = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.end('GET /env/production HTTP/1.0\r\n\r\n');
        });
        let received = '';
        socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
        socket.on('end', () => {
          resolve(received);
        });
        socket.on('error', reject);
      });

      expect(raw).toMatch(/^HTTP\/1\.1 403/);
      expect(raw).toContain('text/plain');
    });
  });

  it.each(['/nope', '/env', '/env/a/b', '/env/a/versions/1/x', '/other/a'])(
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
    ['POST', '/env/production/versions', 'GET'],
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

describe('rollout edits on POST /env/:env/features/:key', () => {
  const rolloutSnapshot = (options: { checkoutSalt?: string; otherEnabled?: boolean } = {}) =>
    JSON.stringify({
      schemaVersion: 2,
      environment: 'production',
      version: 3,
      createdAt: '2026-09-19T06:00:00.000Z',
      createdBy: 'test',
      previousVersion: null,
      reason: 'test',
      features: {
        checkout: {
          type: 'boolean',
          enabled: true,
          rules: [
            { when: { plan: 'free' }, enabled: false },
            { when: { plan: { inSegment: 'beta-testers' } }, rollout: { percentage: 10, bucketBy: 'userId', salt: options.checkoutSalt ?? 'old' }, enabled: true },
          ],
        },
        other: { type: 'boolean', enabled: options.otherEnabled ?? false },
      },
    });

  const ROLLOUT_SNAPSHOT = rolloutSnapshot();

  const rolloutFakes = (overrides: Partial<DashboardPorts> = {}, writer: Partial<SnapshotWriter> = {}) =>
    fakes({ fetchSnapshotText: () => Promise.resolve(ROLLOUT_SNAPSHOT), ...overrides }, writer);


  const featuresOf = (body: string): Record<string, Record<string, unknown>> =>
    (pendingOf(body)?.snapshot['features'] ?? {}) as Record<string, Record<string, unknown>>;
  const rulesOf = (body: string): Record<string, unknown>[] => featuresOf(body)['checkout']?.['rules'] as Record<string, unknown>[];

  it('saves the posted rollout onto the rule the form names, staged rather than published', async () => {
    const { ports, writer } = rolloutFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '2', rollout_1: 'on', percentage_1: '30', bucketBy_1: 'accountId', salt_1: 's' }),
    });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body)[1]?.rollout).toEqual({ percentage: 30, bucketBy: 'accountId', salt: 's' });
    expect(rulesOf(reply.body)[0]).not.toHaveProperty('rollout');
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('removes the rollout from the named rule and leaves the rest of it alone, staged rather than published', async () => {
    const { ports, writer } = rolloutFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '2' }),
    });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body)[1]).not.toHaveProperty('rollout');
    expect(rulesOf(reply.body)[1]?.when).toEqual({ plan: { inSegment: 'beta-testers' } });
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['a percentage above 100', { percentage_1: '130' }],
    ['a percentage that is not a number', { percentage_1: 'half' }],
    ['more than two decimal places', { percentage_1: '30.123' }],
    ['an empty percentage', { percentage_1: '' }],
    ['a missing percentage field', {}],
  ])('answers 400 for %s and stages nothing', async (_, fields) => {
    const { ports, writer } = rolloutFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '2', rollout_1: 'on', bucketBy_1: 'userId', salt_1: 's', ...fields }),
    });

    expect(reply.status).toBe(400);
    expect(reply.body).toContain('percentage');
    expect(writer.publish).not.toHaveBeenCalled();
    expect(pendingOf(reply.body)).toBeUndefined();
  });

  it('answers 400 for a ruleCount past the rules the flag actually has, and stages nothing', async () => {
    const { ports, writer } = rolloutFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '9' }),
    });

    expect(reply.status).toBe(400);
    expect(writer.publish).not.toHaveBeenCalled();
    expect(pendingOf(reply.body)).toBeUndefined();
  });

  it('treats a rollout posted without a bucket attribute or salt as invalid input, not as empty strings', async () => {
    const { ports, writer } = rolloutFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '2', rollout_1: 'on', percentage_1: '30' }),
    });

    // parseSnapshot rejects the empty bucketBy, so this is an invalid snapshot (422), not a malformed field (400).
    expect(reply.status).toBe(422);
    expect(reply.body).toContain('not valid');
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('rejects a rollout POST without an Origin before opening a writer', async () => {
    const { ports, openWriter } = rolloutFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '2', rollout_1: 'on', percentage_1: '30', bucketBy_1: 'userId', salt_1: 's' }),
      sameOrigin: false,
    });

    expect(reply.status).toBe(403);
    expect(openWriter).not.toHaveBeenCalled();
  });

  // Rollout is staged, not published immediately, so drift is surfaced by the Review Dialog at Publish
  // time (see "reviewing a pending change set"), not by a per-field replay-on-latest here.
});

describe('decodeAttachValue', () => {
  it.each([
    ['a plain word', 'dark', 'dark'],
    ['a word padded with spaces', '  dark  ', 'dark'],
    ['empty text', '', ''],
    ['a version string', '1.2.3', '1.2.3'],
    ['a leading-zero id', '007', '007'],
    ['a signed number', '+1', '+1'],
    ['a number with a trailing dot', '1.', '1.'],
    ['an integer', '42', 42],
    ['a negative decimal', '-2.5', -2.5],
    ['exponent notation', '1e3', 1000],
    ['true', 'true', true],
    ['false', 'false', false],
    ['null', 'null', null],
    ['a quoted string', '"dark"', 'dark'],
    ['an object literal', '{"max":3}', { max: 3 }],
    ['a padded object literal', '  {"max":3}  ', { max: 3 }],
    ['an array literal', '[1,2]', [1, 2]],
  ])('reads %s as %j', (_, raw, expected) => {
    expect(decodeAttachValue(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['a truncated object', '{"max":'],
    ['a truncated array', '[1,'],
    ['an unterminated string', '"dark'],
    ['a padded truncated object', '  {"max":  '],
  ])('rejects %s', (_, raw) => {
    expect(decodeAttachValue(raw)).toEqual({ ok: false });
  });
});

describe('attaching and detaching segments', () => {
  const ATTACH_SNAPSHOT = JSON.stringify({
    schemaVersion: 2,
    environment: 'production',
    version: 3,
    createdAt: '2026-09-19T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: null,
    reason: 'test',
    features: {
      checkout: { type: 'boolean', enabled: true, rules: [{ when: { plan: 'free' }, enabled: false }] },
      theme: { type: 'config', enabled: true, default: 'light', rules: [{ when: { plan: 'free' }, value: 'plain' }] },
    },
  });

  const PUBLISHED = [
    { segmentKey: 'beta-testers', version: 2, memberAttribute: 'userId' },
    { segmentKey: 'legacy', version: 1 },
  ] as const;

  const attachFakes = (writer: Partial<SnapshotWriter> = {}) =>
    fakes(
      {
        fetchSnapshotText: () => Promise.resolve(ATTACH_SNAPSHOT),
        listPublishedSegments: () => Promise.resolve({ status: 'listed', segments: PUBLISHED }),
      },
      writer,
    );

  const featuresOf = (body: string): Record<string, Record<string, unknown>> =>
    (pendingOf(body)?.snapshot['features'] ?? {}) as Record<string, Record<string, unknown>>;
  const rulesOf = (body: string, key: string): Record<string, unknown>[] =>
    (featuresOf(body)[key] as { rules: Record<string, unknown>[] } | undefined)?.rules ?? [];

  const ATTACH_FORM = {
    baseVersion: '3',
    field: 'save',
    segmentKey: 'beta-testers',
  };

  it('appends a segment rule to a boolean flag, keeping the rules already there — staged, not published', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', { body: form(ATTACH_FORM) });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body, 'checkout')).toEqual([
      { when: { plan: 'free' }, enabled: false },
      { when: { userId: { inSegment: 'beta-testers' } }, enabled: true },
    ]);
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['a plain word', 'dark', 'dark'],
    ['a number', '42', 42],
    ['true', 'true', true],
    ['an object literal', '{"max":3}', { max: 3 }],
  ])('attaches %s to a config flag as %j', async (_, typed, expected) => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/theme', {
      body: form({ ...ATTACH_FORM, value: typed }),
    });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body, 'theme')[1]).toEqual({ when: { userId: { inSegment: 'beta-testers' } }, value: expected });
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('answers 400 and stages nothing when the value looks like JSON but does not parse', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/theme', {
      body: form({ ...ATTACH_FORM, value: '{"max":' }),
    });

    expect(reply.status).toBe(400);
    expect(reply.body).toContain('The value starts like JSON but is not valid JSON');
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('takes the member attribute from the chosen segment, ignoring one submitted with the form', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ ...ATTACH_FORM, memberAttribute: 'spoofed' }),
    });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body, 'checkout')[1]).toEqual({
      when: { userId: { inSegment: 'beta-testers' } },
      enabled: true,
    });
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('stages nothing when Segment is left on its placeholder', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save' }),
    });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body, 'checkout')).toEqual([{ when: { plan: 'free' }, enabled: false }]);
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it.each([['a key that is not published', { segmentKey: '-nope' }]])(
    'answers 400 for %s, stages nothing and says to choose from the list',
    async (_, chosen) => {
      const { ports, writer } = attachFakes();
      const dashboard = await start(ports);

      const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
        body: form({ baseVersion: '3', field: 'save', ...chosen }),
      });

      expect(reply.status).toBe(400);
      expect(reply.body).toContain('not published in this environment');
      expect(writer.publish).not.toHaveBeenCalled();
    },
  );

  it('answers 400 and stages nothing for a segment whose member attribute was never recorded', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ ...ATTACH_FORM, segmentKey: 'legacy' }),
    });

    expect(reply.status).toBe(400);
    expect(reply.body).toContain('before its member attribute was recorded');
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('answers 400 and stages nothing when the published segment list cannot be read', async () => {
    const { ports, writer } = fakes({
      fetchSnapshotText: () => Promise.resolve(ATTACH_SNAPSHOT),
      listPublishedSegments: () => Promise.resolve({ status: 'unavailable' }),
    });
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', { body: form(ATTACH_FORM) });

    expect(reply.status).toBe(400);
    expect(reply.body).toContain('could not be read');
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('offers the published segments as a picker on the environment page', async () => {
    const { ports } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'GET', '/env/production');

    expect(reply.body).toContain('<select name="segmentKey">');
    expect(reply.body).toContain('<option value="beta-testers">beta-testers · userId</option>');
    expect(reply.body).toContain('<option value="legacy" disabled>legacy · attribute unknown</option>');
  });

  it('detaches the rule at index 0, staged rather than published', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '1', detach_0: 'on' }),
    });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body, 'checkout')).toEqual([]);
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('treats a ruleCount that does not parse as a plain non-negative integer as zero rules, staging nothing', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '-1', detach_0: 'on' }),
    });

    expect(reply.status).toBe(200);
    expect(rulesOf(reply.body, 'checkout')).toEqual([{ when: { plan: 'free' }, enabled: false }]);
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('answers 400 for a Detach past the last rule and stages nothing', async () => {
    const { ports, writer } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ baseVersion: '3', field: 'save', ruleCount: '9', detach_8: 'on' }),
    });

    expect(reply.status).toBe(400);
    expect(writer.publish).not.toHaveBeenCalled();
    expect(pendingOf(reply.body)).toBeUndefined();
  });

  it('rejects a segment edit whose base version is missing, before reading anything', async () => {
    const { ports, openWriter } = attachFakes();
    const dashboard = await start(ports);

    const reply = await call(dashboard, 'POST', '/env/production/features/checkout', {
      body: form({ field: 'save', segmentKey: 'beta-testers' }),
    });

    expect(reply.status).toBe(422);
    expect(openWriter).not.toHaveBeenCalled();
  });
});

describe('the server-side flag filter', () => {
  const flagList = (body: string): string => {
    const list = /<ul class="flag-list">([\s\S]*?)<\/ul>/.exec(body);
    if (list === null) throw new Error('the page rendered no flag list');
    return list[1] as string;
  };

  const rowCount = (body: string): number => (flagList(body).match(/data-flag="/g) ?? []).length;

  it('renders only the matching rows and leaves the others out of the markup', async () => {
    const dashboard = await start(fakes().ports);

    const all = await call(dashboard, 'GET', '/env/production');
    const filtered = await call(dashboard, 'GET', '/env/production?filter=checkout');

    expect(rowCount(all.body)).toBe(2);
    expect(filtered.status).toBe(200);
    expect(rowCount(filtered.body)).toBe(1);
    expect(flagList(filtered.body)).toContain('data-flag="checkout-limits"');
    expect(flagList(filtered.body)).not.toContain('new-dashboard');
    expect(filtered.body).toContain('<p class="muted" data-filter-empty hidden>No flags match.</p>');
  });

  it('answers a filter that matches nothing with 200 and the no-match message, not the flagless one', async () => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'GET', '/env/production?filter=nothing-like-this');

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('No flags match.');
    expect(reply.body).not.toContain('This snapshot defines no flags.');
    expect(rowCount(reply.body)).toBe(0);
  });

  it('keeps the flagless snapshot on its own empty state when a filter is present', async () => {
    const flagless = await start(fakes({ fetchSnapshotText: () => Promise.resolve(snapshotText({})) }).ports);

    const reply = await call(flagless, 'GET', '/env/production?filter=anything');

    expect(reply.body).toContain('This snapshot defines no flags.');
    expect(reply.body).not.toContain('No flags match.');
  });

  it('leaves the single-version page unfiltered', async () => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'GET', '/env/production/versions/2?filter=checkout');

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('<td data-label="Flag"><code>checkout-limits</code></td>');
    expect(reply.body).toContain('<td data-label="Flag"><code>new-dashboard</code></td>');
  });

  it('submits through a GET form that echoes the filter and carries the rest of the query state', async () => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'GET', '/env/production?filter=checkout&page=3&pageSize=25');

    expect(reply.body).toContain('<form class="flag-filter-form" method="get" action="/env/production">');
    expect(reply.body).toContain('<input type="hidden" name="page" value="3">');
    expect(reply.body).toContain('<input type="hidden" name="pageSize" value="25">');
    expect(reply.body).toContain('name="filter" value="checkout"');
    expect(reply.body).not.toContain('name="filter" value="checkout" hidden');
    expect(reply.body).toContain('aria-label="Filter flags by key, type or on/off"');
    expect(reply.body).toContain('<button type="submit" class="button-secondary">Filter</button>');
  });

  it('escapes a filter that tries to break out of the value attribute', async () => {
    const dashboard = await start(fakes().ports);
    const payload = '"><script>alert(1)</script>';

    const reply = await call(dashboard, 'GET', `/env/production?filter=${encodeURIComponent(payload)}`);

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(reply.body).not.toContain('<script>alert(1)</script>');
  });
});
