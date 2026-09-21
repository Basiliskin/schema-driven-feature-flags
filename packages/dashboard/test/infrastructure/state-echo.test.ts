import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILTER_LENGTH, MAX_OPEN_KEYS } from '../../src/infrastructure/url-state.js';
import { startDashboardServer, type DashboardPorts, type RunningDashboard } from '../../src/infrastructure/http-server.js';
import { call, fakes, form, publishError, type Reply } from '../support/dashboard-harness.js';

let running: RunningDashboard | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const start = async (ports: DashboardPorts) => {
  running = await startDashboardServer({ ports, port: 0, logError: vi.fn() });
  return running;
};

/** The two flags the fake snapshot defines; only `new-dashboard` matches the filter these tests submit. */
const VIEW = { filter: 'new', open: 'new-dashboard' };
const MATCHING = 'new-dashboard';
const OTHER = 'checkout-limits';

const flagKeys = (body: string): readonly string[] =>
  [...body.matchAll(/<li class="card flag" data-flag="([^"]+)"/g)].map((match) => match[1] ?? '');

/** A row's own disclosure is the first one after its marker, so that opening tag says whether the row is open. */
const isOpen = (body: string, key: string): boolean => {
  const row = body.slice(body.indexOf(`data-flag="${key}"`));
  return row.slice(row.indexOf('<details class="flag-row')).startsWith('<details class="flag-row" open>');
};

const expectsTheViewBack = (reply: Reply, status: number): void => {
  expect(reply.status).toBe(status);
  expect(reply.headers.location).toBeUndefined();
  expect(flagKeys(reply.body)).toEqual([MATCHING]);
  expect(isOpen(reply.body, MATCHING)).toBe(true);
};

const conflicted = () => fakes({}, { publish: () => Promise.reject(publishError('CONFLICT')) });

/**
 * Every write POST re-renders the page in place, so each of the four page-rendering routes has to put the
 * operator back on the filtered, expanded view they submitted from — at every status it can answer with.
 */
describe('the view a write POST comes back to', () => {
  describe('creating a flag', () => {
    const path = '/env/production/features';

    it('applies the echoed state when the flag is created', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'POST', path, {
        body: form({ ...VIEW, baseVersion: '3', key: 'beta', type: 'boolean' }),
      });

      expectsTheViewBack(reply, 200);
    });

    it('applies it when the input is invalid', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'POST', path, {
        body: form({ ...VIEW, baseVersion: '3', key: 'beta', type: 'neither' }),
      });

      expectsTheViewBack(reply, 422);
      expect(reply.body).toContain('Choose whether the new flag is a boolean or a config flag.');
    });

    it('applies it when the write is rejected', async () => {
      const dashboard = await start(conflicted().ports);

      const reply = await call(dashboard, 'POST', path, {
        body: form({ ...VIEW, baseVersion: '3', key: 'beta', type: 'boolean' }),
      });

      expectsTheViewBack(reply, 422);
    });
  });

  describe('editing a flag', () => {
    const path = `/env/production/features/${MATCHING}`;

    it('applies the echoed state when the edit is saved', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'POST', path, {
        body: form({ ...VIEW, baseVersion: '3', field: 'enabled' }),
      });

      expectsTheViewBack(reply, 200);
    });

    it('applies it when the submitted value is invalid, alongside the draft the operator must correct', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'POST', `/env/production/features/${OTHER}`, {
        body: form({ ...VIEW, baseVersion: '3', field: 'attachSegment', segmentKey: 'not-published', value: 'x' }),
      });

      expect(reply.status).toBe(400);
      expect(reply.headers.location).toBeUndefined();
      expect(flagKeys(reply.body)).toEqual([MATCHING]);
      expect(reply.body).toContain('Choose a segment from the list');
    });

    it('applies it when the edit is rejected', async () => {
      const dashboard = await start(conflicted().ports);

      const reply = await call(dashboard, 'POST', path, {
        body: form({ ...VIEW, baseVersion: '3', field: 'enabled' }),
      });

      expectsTheViewBack(reply, 422);
    });
  });

  describe('publishing a snapshot', () => {
    const path = '/env/production/publish';
    const snapshot = JSON.stringify({ schemaVersion: 1, createdBy: 'test', reason: 'test', features: {} });

    it('applies the echoed state when the snapshot is published', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'POST', path, { body: form({ ...VIEW, baseVersion: '3', snapshot }) });

      expectsTheViewBack(reply, 200);
    });

    // A pasted snapshot is rejected rather than called invalid input, so this route answers 200 and 422 only.
    it('applies it when the draft does not parse, and still re-renders the draft', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'POST', path, { body: form({ ...VIEW, baseVersion: '3', snapshot: '{' }) });

      expectsTheViewBack(reply, 422);
      expect(reply.body).toContain('<textarea id="snapshot" name="snapshot" rows="16" required spellcheck="false">{</textarea>');
    });

    it('applies it when the publish is rejected', async () => {
      const dashboard = await start(conflicted().ports);

      const reply = await call(dashboard, 'POST', path, { body: form({ ...VIEW, baseVersion: '3', snapshot }) });

      expectsTheViewBack(reply, 422);
    });
  });

  // A rollback names its version in the URL-independent `version` field; a malformed one is answered by the
  // error page rather than by this page, so this route has a 200 and a 422 outcome but no 400 one.
  describe('restoring a version', () => {
    const path = '/env/production/rollback';

    it('applies the echoed state when the version is restored', async () => {
      const dashboard = await start(fakes().ports);

      const reply = await call(dashboard, 'POST', path, { body: form({ ...VIEW, version: '2' }) });

      expectsTheViewBack(reply, 200);
    });

    it('applies it when the restore is rejected', async () => {
      const dashboard = await start(fakes({}, { rollback: () => Promise.reject(publishError('CONFLICT')) }).ports);

      const reply = await call(dashboard, 'POST', path, { body: form({ ...VIEW, version: '2' }) });

      expectsTheViewBack(reply, 422);
    });
  });

  it('renders the whole, collapsed list when a POST carries no state at all', async () => {
    const dashboard = await start(fakes().ports);

    const reply = await call(dashboard, 'POST', '/env/production/rollback', { body: form({ version: '2' }) });

    expect(reply.status).toBe(200);
    expect(flagKeys(reply.body)).toEqual([MATCHING, OTHER]);
    expect(reply.body).not.toContain('<details class="flag-row" open>');
  });
});

/** The hidden fields are as client-supplied as a query string, so the POST path gets the same caps and escaping. */
describe('state arriving as form fields rather than in the URL', () => {
  const post = async (fields: Record<string, string>): Promise<Reply> => {
    const dashboard = await start(fakes().ports);
    return call(dashboard, 'POST', '/env/production/rollback', { body: form({ version: '2', ...fields }) });
  };

  it('keeps no more open keys than the URL path would', async () => {
    const keys = Array.from({ length: 500 }, (_, index) => `flag-${String(index)}`);

    const reply = await post({ open: keys.join(',') });

    expect(reply.body.match(/data-open-toggle href="[^"]*open=/g)).toHaveLength(2);
    expect(new URL(`http://x${/data-open-toggle href="([^"]+)"/.exec(reply.body)?.[1] ?? ''}`).searchParams.get('open')?.split(',')).toHaveLength(
      MAX_OPEN_KEYS + 1,
    );
  });

  it('truncates an over-long filter to the same cap', async () => {
    const reply = await post({ filter: 'x'.repeat(10_000) });

    expect(reply.body).toContain(`name="filter" value="${'x'.repeat(MAX_FILTER_LENGTH)}"`);
    expect(reply.body).not.toContain('x'.repeat(MAX_FILTER_LENGTH + 1));
  });

  it('escapes a payload rather than re-emitting it into the next page', async () => {
    const reply = await post({ filter: '"><script>x' });

    expect(reply.body).not.toContain('<script>x');
    expect(reply.body).toContain('name="filter" value="&quot;&gt;&lt;script&gt;x"');
  });

  it('falls back to the first page when the page field has been tampered with, rather than failing the write', async () => {
    const reply = await post({ page: '0' });

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Restored version 2 of production as version 2.');
  });
});
