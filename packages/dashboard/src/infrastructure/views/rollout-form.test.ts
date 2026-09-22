import { describe, expect, it } from 'vitest';
import { NO_URL_STATE } from '../url-state.js';
import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { renderFeatureEditForm, type EditContext } from './feature-edit-form.js';
import { renderRolloutFields } from './rollout-form.js';
import { STYLESHEET } from './stylesheet.js';

const CONTEXT: EditContext = { environment: 'production', baseVersion: 7, urlState: NO_URL_STATE };

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

const render = (rules: readonly unknown[]): string => renderRolloutFields(flagWith(rules));

describe('renderRolloutFields', () => {
  it('shows a badge only for the rule that has a rollout', () => {
    const html = render([ROLLED_OUT_RULE, PLAIN_RULE]);
    expect(html).toContain('25% by userId');
    expect(html.match(/badge-rollout/g)).toHaveLength(1);
    expect(html).toContain('No rollout');
  });

  it('carries no form of its own, since it is nested inside the single flag-edit form', () => {
    expect(render([ROLLED_OUT_RULE, PLAIN_RULE])).not.toContain('<form');
  });

  it('addresses each rule by an index suffix on its field names, from zero, with a ruleCount hint for the server', () => {
    const html = render([ROLLED_OUT_RULE, PLAIN_RULE]);
    expect(html).toContain('<input type="hidden" name="ruleCount" value="2">');
    expect(html).toContain('name="percentage_0"');
    expect(html).toContain('name="percentage_1"');
    expect(html).toContain('name="rollout_0"');
    expect(html).toContain('name="rollout_1"');
  });

  it('labels rules from one while indexing their fields from zero', () => {
    const html = render([PLAIN_RULE, ROLLED_OUT_RULE]);
    expect(html).toContain('Rule 2');
    const second = html.slice(html.indexOf('Rule 2'));
    expect(second).toContain('name="rollout_1"');
  });

  it('checks the Rollout toggle only for the rule that already has one', () => {
    const html = render([ROLLED_OUT_RULE, PLAIN_RULE]);
    expect(html).toContain('name="rollout_0" checked');
    expect(html).not.toContain('name="rollout_1" checked');
  });

  it('prefills the fields from the existing rollout and defaults an empty rule', () => {
    expect(render([ROLLED_OUT_RULE])).toContain('name="salt_0" value="launch"');
    const empty = render([PLAIN_RULE]);
    expect(empty).toContain('name="percentage_0" min="0" max="100" step="0.01" value="0"');
    expect(empty).toContain('name="bucketBy_0" value="userId"');
  });

  it('lists the segment keys a rule references, de-duplicated', () => {
    const html = render([
      { when: { userId: { inSegment: 'beta-testers' }, accountId: { inSegment: 'beta-testers' }, org: { inSegment: 'vips' } }, enabled: true },
    ]);
    const listed = html.slice(html.indexOf('<li class="rule-segment">'), html.indexOf('badge-segment'));
    expect(listed).toContain('<code>beta-testers</code>');
    expect(listed).toContain('<code>vips</code>');
    expect(listed.match(/beta-testers/g)).toHaveLength(1);
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

const SEGMENT_RULE_25 = {
  when: { userId: { inSegment: 'beta-testers' } },
  rollout: { percentage: 25, bucketBy: 'userId', salt: 'launch' },
  enabled: true,
};
const SEGMENT_RULE_FULL = { when: { userId: { inSegment: 'vips' } }, enabled: true };

describe('the attached segments of a flag', () => {
  it('lists every attached segment with its own percentage', () => {
    const html = render([SEGMENT_RULE_25, SEGMENT_RULE_FULL]);
    expect(html).toContain('<code>beta-testers</code>');
    expect(html).toContain('25% of members');
    expect(html).toContain('<code>vips</code>');
    expect(html).toContain('100% of members');
  });

  it('gives each attached segment its own Detach checkbox carrying that rule’s index in its name', () => {
    const html = render([SEGMENT_RULE_25, SEGMENT_RULE_FULL]);
    expect(html).toContain('name="detach_0"');
    expect(html).toContain('name="detach_1"');
  });

  it('indexes Detach against the full rules array, not the segment rules alone', () => {
    const html = render([PLAIN_RULE, SEGMENT_RULE_FULL]);
    expect(html).not.toContain('name="detach_0"');
    expect(html).toContain('name="detach_1"');
  });

  it('offers no Detach for a rule that targets no segment', () => {
    expect(render([PLAIN_RULE])).not.toContain('detach_0');
  });

  it('names the attached segment(s) in the collapsed summary, de-duplicated across rules', () => {
    expect(render([SEGMENT_RULE_25])).toContain('<summary>Rollout <span class="muted">· beta-testers</span></summary>');
    expect(render([SEGMENT_RULE_25, SEGMENT_RULE_FULL])).toContain(
      '<summary>Rollout <span class="muted">· beta-testers, vips</span></summary>',
    );
    expect(render([SEGMENT_RULE_25, { ...SEGMENT_RULE_25, rollout: { percentage: 50, bucketBy: 'userId', salt: 's' } }])).toContain(
      '<summary>Rollout <span class="muted">· beta-testers</span></summary>',
    );
  });

  it('leaves the summary plain when no rule targets a segment', () => {
    expect(render([ROLLED_OUT_RULE, PLAIN_RULE])).toContain('<summary>Rollout</summary>');
  });
});

describe('the flag editor', () => {
  it('nests the rollout fields inside the one flag-edit form, since they stage on the same Save', () => {
    const html = renderFeatureEditForm(flagWith([ROLLED_OUT_RULE]), CONTEXT);
    const rollout = html.indexOf('<details class="rollouts">');
    expect(rollout).toBeGreaterThan(html.indexOf('<form method="post"'));
    expect(rollout).toBeLessThan(html.lastIndexOf('</form>'));
    expect(html.slice(rollout)).toContain('25% by userId');
  });
});

describe('the stylesheet', () => {
  it('serves the rollout rules', () => {
    expect(STYLESHEET).toContain('.badge-rollout');
    expect(STYLESHEET).toContain('.rule-segments');
  });
});
