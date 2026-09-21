import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { escapeHtml } from './escape.js';
import type { WriteFormContext } from './state-fields.js';

interface RolloutView {
  readonly percentage: number;
  readonly bucketBy: string;
  readonly salt: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readRollout = (rule: unknown): RolloutView | undefined => {
  if (!isObject(rule) || !isObject(rule.rollout)) return undefined;
  const { percentage, bucketBy, salt } = rule.rollout;
  return typeof percentage === 'number' && typeof bucketBy === 'string' && typeof salt === 'string'
    ? { percentage, bucketBy, salt }
    : undefined;
};

/** A condition is a flat map of attribute to scalar or single-operator expression, so `inSegment` sits one level down. */
const segmentKeysOf = (rule: unknown): readonly string[] => {
  if (!isObject(rule) || !isObject(rule.when)) return [];
  const keys = Object.values(rule.when)
    .map((value) => (isObject(value) ? value.inSegment : undefined))
    .filter((key): key is string => typeof key === 'string');
  return [...new Set(keys)];
};

const renderRolloutBadge = (rollout: RolloutView | undefined): string =>
  rollout === undefined
    ? '<span class="muted">No rollout</span>'
    : `<span class="badge badge-rollout">${escapeHtml(String(rollout.percentage))}% by ${escapeHtml(rollout.bucketBy)}</span>`;

/**
 * The attached-segment row for one rule: its keys, the share of members the rule reaches (a rule with no
 * rollout reaches all of them) and a Detach button. Detach is its own form so pressing it cannot also
 * submit the rollout fields sitting beside it, and it carries the rule's index in the full rules array.
 */
const renderSegmentKeys = (
  keys: readonly string[],
  ruleIndex: number,
  rollout: RolloutView | undefined,
  form: WriteFormContext,
): string => {
  if (keys.length === 0) return '';
  const index = String(ruleIndex);
  const percentage = String(rollout?.percentage ?? 100);
  return `<ul class="rule-segments">
<li class="rule-segment">Segments ${keys.map((key) => `<code>${escapeHtml(key)}</code>`).join(' ')}
<span class="badge badge-segment">${escapeHtml(percentage)}% of members</span>
<form method="post" action="${escapeHtml(form.action)}">${form.baseVersionInput}${form.stateInputs}
<input type="hidden" name="ruleIndex" value="${escapeHtml(index)}">
<button type="submit" class="button-secondary" name="field" value="detachSegment">Detach</button>
</form>
</li>
</ul>`;
};

const renderRuleRollout = (rule: unknown, ruleIndex: number, form: WriteFormContext): string => {
  const rollout = readRollout(rule);
  const index = String(ruleIndex);
  const remove =
    rollout === undefined
      ? ''
      : `<button type="submit" class="button-secondary" name="field" value="removeRollout">Remove</button>`;
  return `<li class="rule-rollout">
<div class="rule-head"><span class="rule-label">Rule ${String(ruleIndex + 1)}</span>${renderRolloutBadge(rollout)}</div>
${renderSegmentKeys(segmentKeysOf(rule), ruleIndex, rollout, form)}
<form method="post" action="${escapeHtml(form.action)}">${form.baseVersionInput}${form.stateInputs}
<div class="form-row">
<input type="hidden" name="ruleIndex" value="${escapeHtml(index)}">
<label>Percentage <input type="number" name="percentage" min="0" max="100" step="0.01" value="${escapeHtml(String(rollout?.percentage ?? 0))}"></label>
<label>Bucket by <input type="text" name="bucketBy" value="${escapeHtml(rollout?.bucketBy ?? 'userId')}"></label>
<label>Salt <input type="text" name="salt" value="${escapeHtml(rollout?.salt ?? '')}"></label>
<button type="submit" name="field" value="setRollout">Save rollout</button>${remove}
</div>
</form>
</li>`;
};

/**
 * One row per rule, each holding its own rollout form and, when the rule targets a segment, its own
 * Detach form. Both carry that rule's index, so the two controls on a row always address the same rule.
 */
export const renderRolloutForms = (flag: FlagDefinitionView, form: WriteFormContext): string => {
  if (flag.rules.length === 0) return '';
  const rows = flag.rules.map((rule, ruleIndex) => renderRuleRollout(rule, ruleIndex, form)).join('\n');
  return `<details class="rollouts"><summary>Rollout</summary>
<div class="stack">
<ul class="rollout-list">
${rows}
</ul>
</div>
</details>`;
};
