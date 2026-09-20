import { describe, expect, it } from 'vitest';
import type { FlagDefinitionView } from '../../application/browse-environment.js';
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

const render = (of: FlagDefinitionView, context: Partial<AttachContext> = {}): string =>
  renderSegmentAttachForm(of, {
    action: '/env/production/features/checkout',
    baseVersionInput: BASE_VERSION_INPUT,
    segmentKeys: [],
    ...context,
  });

describe('renderSegmentAttachForm', () => {
  it('posts the attach field and the base version to the flag’s own edit action', () => {
    const html = render(flag('boolean'));
    expect(html).toContain('<form method="post" action="/env/production/features/checkout"');
    expect(html).toContain('name="field" value="attachSegment"');
    expect(html).toContain(BASE_VERSION_INPUT);
  });

  it('suggests the keys the snapshot already references without closing the input to them', () => {
    const html = render(flag('boolean'), { segmentKeys: ['beta-testers', 'vips'] });
    expect(html).toContain('<datalist id="attach-segments-checkout">');
    expect(html).toContain('<option value="beta-testers"></option>');
    expect(html).toContain('<option value="vips"></option>');
    expect(html).toContain('name="segmentKey" list="attach-segments-checkout"');
    expect(html).not.toContain('<select');
  });

  it('still accepts a typed key when the snapshot references none', () => {
    const html = render(flag('boolean'));
    expect(html).not.toContain('<datalist');
    expect(html).toContain('<input type="text" name="segmentKey" value=""');
  });

  it('defaults the member attribute to userId', () => {
    expect(render(flag('boolean'))).toContain('name="memberAttribute" value="userId"');
  });

  it('offers a plain-text value field for a config flag and says JSON is not needed', () => {
    const html = render(flag('config'));
    expect(html).toContain('<label>Value for members <input type="text" name="value"');
    expect(html).toContain('A plain word, a number or true/false is fine');
    expect(html).not.toContain('JSON</label>');
  });

  it('offers no value field for a boolean flag', () => {
    expect(render(flag('boolean'))).not.toContain('name="value"');
  });

  it('echoes back what a rejected submission had typed', () => {
    const html = render(flag('config'), {
      draft: { segmentKey: 'beta-testers', memberAttribute: 'accountId', segmentValue: 'gold' },
    });
    expect(html).toContain('name="segmentKey" value="beta-testers"');
    expect(html).toContain('name="memberAttribute" value="accountId"');
    expect(html).toContain('name="value" value="gold"');
  });

  it('falls back to the defaults when a draft carries none of the attach fields', () => {
    const html = render(flag('config'), { draft: {} });
    expect(html).toContain('name="segmentKey" value=""');
    expect(html).toContain('name="memberAttribute" value="userId"');
    expect(html).toContain('name="value" value=""');
  });

  it('escapes the flag key, the suggested keys and the typed draft', () => {
    const html = render(flag('config', '"><script>f</script>'), {
      segmentKeys: ['"><script>k</script>'],
      draft: { segmentKey: '<script>d</script>', memberAttribute: '<script>a</script>', segmentValue: '<script>v</script>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;d&lt;/script&gt;');
  });
});

describe('the flag editor', () => {
  it('shows the attach form for every flag, defaulting to no suggestions when none were passed', () => {
    const context: EditContext = { environment: 'production', baseVersion: 7 };
    const html = renderFeatureEditForm(flag('boolean'), context);
    expect(html).toContain('Attach a segment');
    expect(html).not.toContain('<datalist');
  });

  it('passes the snapshot’s referenced keys and the rejected draft into the attach form', () => {
    const context: EditContext = {
      environment: 'production',
      baseVersion: 7,
      segmentKeys: ['beta-testers'],
      draft: { key: 'checkout', segmentKey: 'vips', message: 'No such segment', issues: [] },
    };
    const html = renderFeatureEditForm(flag('boolean'), context);
    expect(html).toContain('<option value="beta-testers"></option>');
    expect(html).toContain('name="segmentKey" list="attach-segments-checkout" value="vips"');
    expect(html).toContain('No such segment');
  });

  it('renders no member value anywhere, whatever the draft carried', () => {
    const context: EditContext = {
      environment: 'production',
      baseVersion: 7,
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
