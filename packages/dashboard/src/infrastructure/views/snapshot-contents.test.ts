import { describe, expect, it } from 'vitest';
import { NO_URL_STATE } from '../url-state.js';
import type { FlagDefinitionView, SnapshotContents } from '../../application/browse-environment.js';
import type { EditContext } from './feature-edit-form.js';
import { renderSnapshotContents } from './snapshot-contents.js';

const BOOLEAN: FlagDefinitionView = { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0, rules: [] };
const CONFIG: FlagDefinitionView = { key: 'checkout-limits', type: 'config', enabled: false, defaultValue: { max: 3 }, ruleCount: 1, rules: [{ when: { plan: 'pro' }, value: { max: 9 } }] };
const METADATA = { createdAt: '2026-09-19T06:00:00.000Z', createdBy: 'ops', reason: 'Launch' };
const CONTENTS: SnapshotContents = { status: 'valid', flags: [BOOLEAN, CONFIG], metadata: METADATA, segmentKeys: [], raw: {} };
const CONTEXT: EditContext = { environment: 'production', baseVersion: 7, urlState: NO_URL_STATE };

const rowOf = (html: string, key: string): string => {
  const start = html.indexOf(`<li class="card flag" data-flag="${key}"`);
  return html.slice(start, html.indexOf('</li>', start));
};

const isOpen = (html: string, key: string): boolean => !rowOf(html, key).includes('<div class="flag-panel" hidden>');

describe('renderSnapshotContents flag panel visibility', () => {
  it('hides the panel of a flag with no draft', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT);
    expect(isOpen(html, 'new-dashboard')).toBe(false);
    expect(isOpen(html, 'checkout-limits')).toBe(false);
  });

  it('shows the panel of a flag holding a rejected draft, and hides the others', () => {
    const draft = { key: 'checkout-limits', message: 'Edit failed here', issues: [] };
    const html = renderSnapshotContents(CONTENTS, { ...CONTEXT, draft });
    expect(isOpen(html, 'checkout-limits')).toBe(true);
    expect(rowOf(html, 'checkout-limits')).toContain('Edit failed here');
    expect(isOpen(html, 'new-dashboard')).toBe(false);
  });

  it('renders the flag list unfiltered when no editable context is given', () => {
    const html = renderSnapshotContents(CONTENTS);
    expect(html).toContain('<table class="flag-table">');
    expect(html).not.toContain('flag-panel');
  });
});

describe('renderSnapshotContents flag row', () => {
  it('links the flag key to its own page and opens it in the shared overlay when scripted', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT);
    const row = rowOf(html, 'new-dashboard');
    expect(row).toContain('<a href="/env/production/features/new-dashboard" data-open-flag="new-dashboard">new-dashboard</a>');
  });

  it('puts the row summary in a plain div rather than behind a details/summary disclosure', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT);
    const row = rowOf(html, 'new-dashboard');
    expect(row.startsWith('<li class="card flag"')).toBe(true);
    expect(row).toContain('<div class="flag-row">\n<div class="flag-row-summary">');
    expect(row).not.toContain('data-open-toggle');
    expect(row).not.toContain('>Expand<');
    expect(row).not.toContain('>Collapse<');
  });
});

describe('renderSnapshotContents hostile flag keys', () => {
  const HOSTILE = 'a"b&c d';
  const CONTENTS_HOSTILE: SnapshotContents = { ...CONTENTS, flags: [{ ...BOOLEAN, key: HOSTILE }] };

  it('carries the same key into data-flag and data-search with no double escaping', () => {
    const html = renderSnapshotContents(CONTENTS_HOSTILE, CONTEXT);
    expect(html).toContain('data-flag="a&quot;b&amp;c d"');
    expect(html).toContain('data-search="a&quot;b&amp;c d boolean on"');
    expect(html).not.toContain('&amp;amp;');
  });

  it('percent-encodes the key into the flag page href', () => {
    const html = renderSnapshotContents(CONTENTS_HOSTILE, CONTEXT);
    expect(html).toContain('href="/env/production/features/a%22b%26c%20d"');
  });
});
