import { describe, expect, it } from 'vitest';
import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { renderFeatureEditForm, type EditContext } from './feature-edit-form.js';
import { renderRolloutForms } from './rollout-form.js';
import { STYLESHEET } from './stylesheet.js';

const ACTION = '/env/production/features/checkout';
const BASE_VERSION_INPUT = '<input type="hidden" name="baseVersion" value="7">';
const CONTEXT: EditContext = { environment: 'production', baseVersion: 7 };

const flagWith = (rules: readonly unknown[]): FlagDefinitionView => ({
  key: 'checkout',
  type: 'boolean',
  enabled: true,
  defaultValue: false,
  ruleCount: rules.length,
  rules,
});

const ROLLED_OUT_RULE = {
  when: { plan: 'pro' },
  rollout: { percentage: 25, bucketBy: 'userId', salt: 'launch' },
  enabled: true,
};
const PLAIN_RULE = { when: { plan: 'free' }, enabled: false };

const render = (rules: readonly unknown[]): string => renderRolloutForms(flagWith(rules), ACTION, BASE_VERSION_INPUT);

describe('renderRolloutForms', () => {
  it('shows a badge only for the rule that has a rollout', () => {
    const html = render([ROLLED_OUT_RULE, PLAIN_RULE]);
    expect(html).toContain('25% by userId');
    expect(html.match(/badge-rollout/g)).toHaveLength(1);
    expect(html).toContain('No rollout');
  });

  it('renders one form per rule, each carrying its own rule index and the base version', () => {
    const html = render([ROLLED_OUT_RULE, PLAIN_RULE]);
    expect(html.match(/<form method="post"/g)).toHaveLength(2);
    expect(html).toContain('<input type="hidden" name="ruleIndex" value="0">');
    expect(html).toContain('<input type="hidden" name="ruleIndex" value="1">');
    expect(html.match(/name="baseVersion" value="7"/g)).toHaveLength(2);
  });

  it('labels rules from one while indexing them from zero', () => {
    const html = render([PLAIN_RULE, ROLLED_OUT_RULE]);
    expect(html).toContain('Rule 2');
    const second = html.slice(html.indexOf('Rule 2'));
    expect(second).toContain('name="ruleIndex" value="1"');
  });

  it('offers Remove only where a rollout exists', () => {
    expect(render([ROLLED_OUT_RULE])).toContain('value="removeRollout"');
    expect(render([PLAIN_RULE])).not.toContain('value="removeRollout"');
  });

  it('prefills the form from the existing rollout and defaults an empty rule', () => {
    expect(render([ROLLED_OUT_RULE])).toContain('name="salt" value="launch"');
    const empty = render([PLAIN_RULE]);
    expect(empty).toContain('name="percentage" min="0" max="100" step="0.01" value="0"');
    expect(empty).toContain('name="bucketBy" value="userId"');
  });

  it('lists the segment keys a rule references, de-duplicated', () => {
    const html = render([
      { when: { userId: { inSegment: 'beta-testers' }, accountId: { inSegment: 'beta-testers' }, org: { inSegment: 'vips' } }, enabled: true },
    ]);
    expect(html).toContain('<code>beta-testers</code>');
    expect(html).toContain('<code>vips</code>');
    expect(html.match(/beta-testers/g)).toHaveLength(1);
  });

  it('shows no segment line for a rule whose conditions reference none', () => {
    expect(render([PLAIN_RULE])).not.toContain('rule-segments');
  });

  it('escapes the salt, the bucket attribute and segment keys', () => {
    const html = render([
      {
        when: { plan: { inSegment: '<script>k</script>' } },
        rollout: { percentage: 10, bucketBy: '<script>b</script>', salt: '"><script>s</script>' },
        enabled: true,
      },
    ]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;k&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;script&gt;s&lt;/script&gt;');
  });

  it('ignores a rollout whose stored fields are not the expected types', () => {
    const html = render([{ when: {}, rollout: { percentage: '25', bucketBy: 'userId', salt: 's' }, enabled: true }]);
    expect(html).toContain('No rollout');
  });

  it('ignores a non-object rule and a non-object condition map', () => {
    expect(render(['not-a-rule'])).toContain('No rollout');
    expect(render([{ when: 'not-a-map', enabled: true }])).not.toContain('rule-segments');
  });

  it('renders nothing for a flag with no rules', () => {
    expect(render([])).toBe('');
  });
});

describe('the flag editor', () => {
  it('places the rollout forms outside the enabled/rules form, since forms cannot nest', () => {
    const html = renderFeatureEditForm(flagWith([ROLLED_OUT_RULE]), CONTEXT);
    const rollout = html.indexOf('<details class="rollouts">');
    expect(rollout).toBeGreaterThan(html.indexOf('</form>'));
    expect(html.slice(rollout)).toContain('25% by userId');
  });
});

describe('the stylesheet', () => {
  it('serves the rollout rules', () => {
    expect(STYLESHEET).toContain('.badge-rollout');
    expect(STYLESHEET).toContain('.rule-segments');
  });
});
