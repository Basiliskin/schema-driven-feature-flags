import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { escapeHtml } from './escape.js';

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

const renderSegmentKeys = (keys: readonly string[]): string =>
  keys.length === 0
    ? ''
    : `<p class="rule-segments">Segments ${keys.map((key) => `<code>${escapeHtml(key)}</code>`).join(' ')}</p>`;

const renderRuleRollout = (rule: unknown, ruleIndex: number): string => {
  const rollout = readRollout(rule);
  const index = String(ruleIndex);
  const remove =
    rollout === undefined
      ? ''
      : `<button type="submit" class="button-secondary" name="field" value="removeRollout">Remove</button>`;
  return `<li class="rule-rollout">
<div class="rule-head"><span class="rule-label">Rule ${String(ruleIndex + 1)}</span>${renderRolloutBadge(rollout)}</div>
${renderSegmentKeys(segmentKeysOf(rule))}
<div class="form-row">
<input type="hidden" name="ruleIndex" value="${escapeHtml(index)}">
<label>Percentage <input type="number" name="percentage" min="0" max="100" step="0.01" value="${escapeHtml(String(rollout?.percentage ?? 0))}"></label>
<label>Bucket by <input type="text" name="bucketBy" value="${escapeHtml(rollout?.bucketBy ?? 'userId')}"></label>
<label>Salt <input type="text" name="salt" value="${escapeHtml(rollout?.salt ?? '')}"></label>
<button type="submit" name="field" value="setRollout">Save rollout</button>${remove}
</div>
</li>`;
};

/**
 * One rollout control per rule. Each rule submits its own form so `ruleIndex` and the rollout fields
 * always travel together, whichever rule's button the operator pressed.
 */
export const renderRolloutForms = (flag: FlagDefinitionView, action: string, baseVersionInput: string): string => {
  if (flag.rules.length === 0) return '';
  const forms = flag.rules
    .map(
      (rule, ruleIndex) =>
        `<form method="post" action="${escapeHtml(action)}">${baseVersionInput}
<ul class="rollout-list">
${renderRuleRollout(rule, ruleIndex)}
</ul>
</form>`,
    )
    .join('\n');
  return `<details class="rollouts"><summary>Rollout</summary>
<div class="stack">
${forms}
</div>
</details>`;
};
