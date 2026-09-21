import { describe, expect, it } from 'vitest';
import type { EnvironmentView, FlagDefinitionView, SnapshotContents } from '../../application/browse-environment.js';
import type { PublishedSegmentsView } from '../../application/list-published-segments.js';
import { renderEnvironmentPage } from './environment-page.js';
import { flagPath } from './escape.js';
import { renderFlagPage } from './flag-page.js';

const NO_SEGMENTS: PublishedSegmentsView = { status: 'listed', rows: [] };

const flag: FlagDefinitionView = {
  key: 'new-dashboard',
  type: 'boolean',
  enabled: true,
  defaultValue: true,
  ruleCount: 0,
  rules: [],
};

const validContents: SnapshotContents = {
  status: 'valid',
  flags: [flag],
  metadata: { createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'someone', reason: 'A reason' },
  segmentKeys: [],
  raw: { schemaVersion: 2, environment: 'production', features: {} },
};

const published = (contents?: SnapshotContents): EnvironmentView => ({
  environment: 'production',
  status: 'published',
  currentVersion: 7,
  versions: [{ version: 7 }],
  current:
    contents === undefined
      ? { environment: 'production', version: 7, status: 'not-available' }
      : { environment: 'production', version: 7, status: 'available', contents },
});

const inputNames = (html: string): string[] =>
  [...html.matchAll(/<input\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1] as string).sort();

/** The environment page also carries the publish dialog and the new-flag form, so compare only the flag's own card. */
const cardOf = (html: string, key: string): string => {
  const card = new RegExp(`<li class="card flag" data-flag="${key}"[\\s\\S]*?\n</li>`).exec(html);
  if (card === null) throw new Error(`the page rendered no card for ${key}`);
  return card[0];
};

describe('flagPath', () => {
  it('addresses the flag under its environment and encodes both', () => {
    expect(flagPath('production', 'new-dashboard')).toBe('/env/production/features/new-dashboard');
    expect(flagPath('a/b', 'c/d')).toBe('/env/a%2Fb/features/c%2Fd');
  });
});

describe('the single-flag page', () => {
  it('renders the flag under a back link and a heading', () => {
    const html = renderFlagPage(published(validContents), 'new-dashboard', NO_SEGMENTS) as string;

    expect(html).toContain('<a class="back-link" href="/env/production">Back to production</a>');
    expect(html).toContain('<h1>new-dashboard</h1>');
    expect(html).toContain('<title>production · new-dashboard · FeatureSync</title>');
  });

  it('renders the same edit form the environment page builds for that flag', () => {
    const action = 'action="/env/production/features/new-dashboard"';
    const standalone = renderFlagPage(published(validContents), 'new-dashboard', NO_SEGMENTS) as string;
    const inList = renderEnvironmentPage(published(validContents), { publishedSegments: NO_SEGMENTS });

    expect(standalone).toContain(action);
    expect(inList).toContain(action);
    expect(inputNames(standalone)).toEqual(inputNames(cardOf(inList, 'new-dashboard')));
  });

  it('carries the current version as the edit form base version', () => {
    const html = renderFlagPage(published(validContents), 'new-dashboard', NO_SEGMENTS) as string;

    expect(html).toContain('<input type="hidden" name="baseVersion" value="7">');
  });

  it('has no flag of its own to render for a key the snapshot does not define', () => {
    expect(renderFlagPage(published(validContents), 'does-not-exist', NO_SEGMENTS)).toBeUndefined();
  });

  it('has nothing to render for an environment with no published version', () => {
    expect(renderFlagPage({ environment: 'production', status: 'empty' }, 'new-dashboard', NO_SEGMENTS)).toBeUndefined();
  });

  it('has nothing to render when the current version’s snapshot file is missing', () => {
    expect(renderFlagPage(published(), 'new-dashboard', NO_SEGMENTS)).toBeUndefined();
  });

  it('has nothing to render when the current snapshot is invalid', () => {
    const invalid: SnapshotContents = { status: 'invalid', issues: [{ path: 'features', message: 'not an object' }] };

    expect(renderFlagPage(published(invalid), 'new-dashboard', NO_SEGMENTS)).toBeUndefined();
  });
});
