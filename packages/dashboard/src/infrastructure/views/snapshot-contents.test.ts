import { describe, expect, it } from 'vitest';
import { NO_URL_STATE } from '../url-state.js';
import type { FlagDefinitionView, SnapshotContents } from '../../application/browse-environment.js';
import { parseUrlState, type DashboardUrlState } from '../url-state.js';
import type { EditContext } from './feature-edit-form.js';
import { renderSnapshotContents } from './snapshot-contents.js';

const BOOLEAN: FlagDefinitionView = { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0, rules: [] };
const CONFIG: FlagDefinitionView = { key: 'checkout-limits', type: 'config', enabled: false, defaultValue: { max: 3 }, ruleCount: 1, rules: [{ when: { plan: 'pro' }, value: { max: 9 } }] };
const METADATA = { createdAt: '2026-09-19T06:00:00.000Z', createdBy: 'ops', reason: 'Launch' };
const CONTENTS: SnapshotContents = { status: 'valid', flags: [BOOLEAN, CONFIG], metadata: METADATA, segmentKeys: [], raw: {} };
const CONTEXT: EditContext = { environment: 'production', baseVersion: 7, urlState: NO_URL_STATE };

const urlState = (query: string): DashboardUrlState => parseUrlState(new URLSearchParams(query));

const rowOf = (html: string, key: string): string => {
  const start = html.indexOf(`<li class="card flag" data-flag="${key}"`);
  return html.slice(start, html.indexOf('</li>', start));
};

const isOpen = (html: string, key: string): boolean => rowOf(html, key).includes('<details class="flag-row" open>');

const toggleHref = (html: string, key: string): string =>
  /data-open-toggle href="([^"]*)"/.exec(rowOf(html, key))?.[1] ?? '';

describe('renderSnapshotContents open-row decision', () => {
  it('opens a row whose key is in the URL open list', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState('open=new-dashboard'));
    expect(isOpen(html, 'new-dashboard')).toBe(true);
  });

  it('leaves a row closed when it is neither in the open list nor holding a draft', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState('open=new-dashboard'));
    expect(isOpen(html, 'checkout-limits')).toBe(false);
    expect(rowOf(html, 'checkout-limits')).toContain('<details class="flag-row">');
  });

  it('still opens a row holding a rejected draft when the URL says nothing about it', () => {
    const draft = { key: 'checkout-limits', message: 'Edit failed here', issues: [] };
    const html = renderSnapshotContents(CONTENTS, { ...CONTEXT, draft }, urlState('open=new-dashboard'));
    expect(isOpen(html, 'checkout-limits')).toBe(true);
    expect(rowOf(html, 'checkout-limits')).toContain('Edit failed here');
  });

  it('opens a row that is both in the open list and holding a draft, emitting the attribute once', () => {
    const draft = { key: 'new-dashboard', message: 'Edit failed here', issues: [] };
    const html = renderSnapshotContents(CONTENTS, { ...CONTEXT, draft }, urlState('open=new-dashboard'));
    expect(isOpen(html, 'new-dashboard')).toBe(true);
    expect(rowOf(html, 'new-dashboard').match(/ open/g)).toHaveLength(1);
  });

  it('ignores the open list entirely when no URL state is supplied', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT);
    expect(isOpen(html, 'new-dashboard')).toBe(false);
    expect(html).not.toContain('data-open-toggle');
  });
});

describe('renderSnapshotContents open-toggle link', () => {
  it('adds a closed row to the keys already open', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState('open=new-dashboard'));
    expect(toggleHref(html, 'checkout-limits')).toBe('/env/production?open=new-dashboard%2Ccheckout-limits');
    expect(rowOf(html, 'checkout-limits')).toContain('>Expand</a>');
  });

  it('removes an open row while leaving the other open keys in place', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState('open=new-dashboard,checkout-limits'));
    expect(toggleHref(html, 'new-dashboard')).toBe('/env/production?open=checkout-limits');
    expect(rowOf(html, 'new-dashboard')).toContain('>Collapse</a>');
  });

  it('omits the open parameter entirely once the last open key is removed', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState('open=new-dashboard'));
    expect(toggleHref(html, 'new-dashboard')).toBe('/env/production');
  });

  // The '&' joining two query parameters is written as '&amp;' because escapeHtml wraps the whole
  // attribute; the browser decodes it back to '&' before requesting the URL.
  it('keeps the current filter text in both directions of the link', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState('filter=check&open=new-dashboard'));
    expect(toggleHref(html, 'new-dashboard')).toBe('/env/production?filter=check');
    expect(toggleHref(html, 'checkout-limits')).toBe('/env/production?filter=check&amp;open=new-dashboard%2Ccheckout-limits');
  });

  it('leaves the native disclosure widget in place alongside the link', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState(''));
    const row = rowOf(html, 'new-dashboard');
    expect(row).toContain('<details class="flag-row">');
    expect(row).toContain('<summary>');
    expect(row).toContain('data-open-toggle');
  });

  it('puts no open-list link on the nested rollout, attach, rules or delete panels', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT, urlState(''));
    const row = rowOf(html, 'checkout-limits');
    const nested = row.slice(row.indexOf('</summary>'));
    expect(nested).toContain('<summary>Rollout</summary>');
    expect(nested).not.toContain('data-open-toggle');
  });
});

describe('renderSnapshotContents hostile flag keys', () => {
  const HOSTILE = 'a"b&c d';
  const CONTENTS_HOSTILE: SnapshotContents = { ...CONTENTS, flags: [{ ...BOOLEAN, key: HOSTILE }] };

  it('percent-encodes the key into the href and escapes the finished attribute', () => {
    const html = renderSnapshotContents(CONTENTS_HOSTILE, CONTEXT, urlState(''));
    const href = /data-open-toggle href="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(href).toBe('/env/production?open=a%22b%26c%20d');
    expect(href).not.toContain('"');
    expect(href).not.toContain('&');
  });

  it('carries the same key into data-flag and data-search with no double escaping', () => {
    const html = renderSnapshotContents(CONTENTS_HOSTILE, CONTEXT, urlState(''));
    expect(html).toContain('data-flag="a&quot;b&amp;c d"');
    expect(html).toContain('data-search="a&quot;b&amp;c d boolean on"');
    expect(html).not.toContain('&amp;amp;');
  });

  it('round-trips a hostile key through the parser unchanged', () => {
    const html = renderSnapshotContents(CONTENTS_HOSTILE, CONTEXT, urlState(''));
    const href = /data-open-toggle href="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(urlState(href.slice(href.indexOf('?') + 1)).openFlags).toEqual([HOSTILE]);
  });
});
