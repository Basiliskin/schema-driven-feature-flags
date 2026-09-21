import { describe, expect, it } from 'vitest';
import type { FlagDefinitionView } from '../../application/browse-environment.js';
import type { PublishedSegmentRow, PublishedSegmentsView } from '../../application/list-published-segments.js';
import { renderFeatureEditForm, type EditContext } from './feature-edit-form.js';
import { renderSegmentAttachForm, type AttachContext } from './segment-attach-form.js';
import { STYLESHEET } from './stylesheet.js';

const BASE_VERSION_INPUT = '<input type="hidden" name="baseVersion" value="7">';

const flag = (type: 'boolean' | 'config', key = 'checkout'): FlagDefinitionView => ({
  key,
  type,
  enabled: true,
  defaultValue: type === 'config' ? { tier: 'free' } : false,
  ruleCount: 0,
  rules: [],
});

const row = (segmentKey: string, memberAttribute?: string): PublishedSegmentRow => ({
  segmentKey,
  version: 2,
  attribute: memberAttribute === undefined ? { status: 'unknown' } : { status: 'known', memberAttribute },
  usage: { status: 'unused' },
});

const listed = (...rows: readonly PublishedSegmentRow[]): PublishedSegmentsView => ({ status: 'listed', rows });

const BETA_AND_VIPS = listed(row('beta-testers', 'userId'), row('vips', 'accountId'));

const render = (of: FlagDefinitionView, context: Partial<AttachContext> = {}): string =>
  renderSegmentAttachForm(of, {
    action: '/env/production/features/checkout',
    baseVersionInput: BASE_VERSION_INPUT,
    segments: BETA_AND_VIPS,
    ...context,
  });

/** Every value the browser would actually submit — a disabled option cannot be chosen. */
const selectableValues = (html: string): readonly string[] =>
  [...html.matchAll(/<option value="([^"]*)"(?![^>]*\bdisabled\b)/g)].map((match) => match[1] ?? '');

describe('renderSegmentAttachForm', () => {
  it('posts the attach field and the base version to the flag’s own edit action', () => {
    const html = render(flag('boolean'));
    expect(html).toContain('<form method="post" action="/env/production/features/checkout"');
    expect(html).toContain('name="field" value="attachSegment"');
    expect(html).toContain(BASE_VERSION_INPUT);
  });

  it('offers a required select whose selectable values are exactly the published segment keys', () => {
    const html = render(flag('boolean'));
    expect(html).toContain('<select name="segmentKey" required>');
    expect(selectableValues(html)).toEqual(['beta-testers', 'vips']);
  });

  it('labels each option with its segment key and stored member attribute', () => {
    const html = render(flag('boolean'));
    expect(html).toContain('<option value="beta-testers">beta-testers · userId</option>');
    expect(html).toContain('<option value="vips">vips · accountId</option>');
  });

  it('offers no free-text input for the segment key or the member attribute, and no suggestion list', () => {
    const html = render(flag('boolean'));
    expect(html).not.toContain('name="segmentKey" type=');
    expect(html).not.toContain('<input type="text" name="segmentKey"');
    expect(html).not.toContain('memberAttribute');
    expect(html).not.toContain('<datalist');
    expect(html).not.toContain('<textarea');
  });

  it('starts on a placeholder that cannot be submitted, so no segment is attached by accident', () => {
    const html = render(flag('boolean'));
    expect(html).toContain('<option value="" disabled selected>Choose a segment…</option>');
  });

  it('lists a segment with no stored attribute as unselectable and says the attribute is unknown', () => {
    const html = render(flag('boolean'), { segments: listed(row('beta-testers', 'userId'), row('legacy')) });
    expect(html).toContain('<option value="legacy" disabled>legacy · attribute unknown</option>');
    expect(selectableValues(html)).toEqual(['beta-testers']);
  });

  it('explains itself and renders no form when the environment has no published segments', () => {
    const html = render(flag('boolean'), { segments: listed() });
    expect(html).toContain('No segments are published in this environment yet');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<form');
  });

  it('explains itself and renders no form when the segment list could not be read', () => {
    const html = render(flag('boolean'), { segments: { status: 'unavailable' } });
    expect(html).toContain('could not be read');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<form');
  });

  it('offers a plain-text value field for a config flag and says JSON is not needed', () => {
    const html = render(flag('config'));
    expect(html).toContain('<label>Value for members <input type="text" name="value"');
    expect(html).toContain('A plain word, a number or true/false is fine');
  });

  it('offers no value field for a boolean flag', () => {
    expect(render(flag('boolean'))).not.toContain('name="value"');
  });

  it('re-selects the segment and the value a rejected submission had chosen', () => {
    const html = render(flag('config'), { draft: { segmentKey: 'vips', segmentValue: 'gold' } });
    expect(html).toContain('<option value="vips" selected>');
    expect(html).toContain('<option value="" disabled>Choose a segment…</option>');
    expect(html).toContain('name="value" value="gold"');
  });

  it('keeps the placeholder selected when the draft names a segment that is no longer published', () => {
    const html = render(flag('config'), { draft: { segmentKey: 'gone' } });
    expect(html).toContain('<option value="" disabled selected>');
    expect(html).not.toContain('selected>gone');
  });

  it('falls back to the placeholder when a draft carries none of the attach fields', () => {
    const html = render(flag('config'), { draft: {} });
    expect(html).toContain('<option value="" disabled selected>');
    expect(html).toContain('name="value" value=""');
  });

  it('escapes the published keys, their attributes and the drafted value', () => {
    const html = render(flag('config', '"><script>f</script>'), {
      segments: listed(row('"><script>k</script>', '<script>a</script>')),
      draft: { segmentKey: '<script>d</script>', segmentValue: '<script>v</script>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;v&lt;/script&gt;');
  });
});

describe('the flag editor', () => {
  it('treats a missing published-segment list as unreadable rather than as an empty one', () => {
    const context: EditContext = { environment: 'production', baseVersion: 7 };
    const html = renderFeatureEditForm(flag('boolean'), context);
    expect(html).toContain('Attach a segment');
    expect(html).toContain('could not be read');
  });

  it('passes the published segments and the rejected draft into the attach form', () => {
    const context: EditContext = {
      environment: 'production',
      baseVersion: 7,
      publishedSegments: BETA_AND_VIPS,
      draft: { key: 'checkout', segmentKey: 'vips', message: 'No such segment', issues: [] },
    };
    const html = renderFeatureEditForm(flag('boolean'), context);
    expect(html).toContain('<option value="beta-testers">beta-testers · userId</option>');
    expect(html).toContain('<option value="vips" selected>');
    expect(html).toContain('No such segment');
  });

  it('renders no member value anywhere, whatever the draft carried', () => {
    const context: EditContext = {
      environment: 'production',
      baseVersion: 7,
      publishedSegments: BETA_AND_VIPS,
      draft: { key: 'checkout', segmentKey: 'beta-testers', message: 'Rejected', issues: [] },
    };
    expect(renderFeatureEditForm(flag('boolean'), context)).not.toMatch(/member-\d|@example\.com/);
  });
});

describe('the stylesheet', () => {
  it('serves the attach and attached-segment rules', () => {
    expect(STYLESHEET).toContain('.segment-attach');
    expect(STYLESHEET).toContain('.rule-segment');
    expect(STYLESHEET).toContain('.badge-segment');
  });
});
