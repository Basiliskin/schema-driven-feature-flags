import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { renderConfirmation } from './confirm-dialog.js';
import { escapeHtml } from './escape.js';
import { dialogId } from './modal-dialog.js';
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
 * rollout reaches all of them) and a Detach confirmation. Detach lives outside the rollout form so pressing
 * it cannot also submit the rollout fields sitting beside it, and it carries the rule's index in the full
 * rules array.
 */
const renderSegmentKeys = (
  keys: readonly string[],
  flagKey: string,
  ruleIndex: number,
  rollout: RolloutView | undefined,
  form: WriteFormContext,
): string => {
  if (keys.length === 0) return '';
  const index = String(ruleIndex);
  const percentage = String(rollout?.percentage ?? 100);
  const named = keys.join(', ');
  const markedUp = keys.map((key) => `<code>${escapeHtml(key)}</code>`).join(' ');
  return `<ul class="rule-segments">
<li class="rule-segment">Segments ${markedUp}
<span class="badge badge-segment">${escapeHtml(percentage)}% of members</span>
${renderConfirmation(
    {
      id: dialogId('confirm-detach', flagKey, ruleIndex),
      title: `Detach ${named} from ${flagKey}`,
      prompt: `Detach ${markedUp} from <code>${escapeHtml(flagKey)}</code>? This publishes a new version of the flag without rule ${escapeHtml(String(ruleIndex + 1))}.`,
      triggerLabel: 'Detach',
      confirmLabel: `Detach ${named}`,
      field: 'detachSegment',
      hiddenInputs: `<input type="hidden" name="ruleIndex" value="${escapeHtml(index)}">`,
    },
    form,
  )}
</li>
</ul>`;
};

const renderRuleRollout = (rule: unknown, flagKey: string, ruleIndex: number, form: WriteFormContext): string => {
  const rollout = readRollout(rule);
  const index = String(ruleIndex);
  const label = String(ruleIndex + 1);
  const remove =
    rollout === undefined
      ? ''
      : `\n${renderConfirmation(
          {
            id: dialogId('confirm-remove-rollout', flagKey, ruleIndex),
            title: `Remove the rollout on rule ${label} of ${flagKey}`,
            prompt: `Remove the ${escapeHtml(String(rollout.percentage))}% rollout on rule ${escapeHtml(label)} of <code>${escapeHtml(flagKey)}</code>? The rule stays and reaches every matching member.`,
            triggerLabel: 'Remove',
            confirmLabel: `Remove the rule ${label} rollout`,
            field: 'removeRollout',
            hiddenInputs: `<input type="hidden" name="ruleIndex" value="${escapeHtml(index)}">`,
          },
          form,
        )}`;
  return `<li class="rule-rollout">
<div class="rule-head"><span class="rule-label">Rule ${label}</span>${renderRolloutBadge(rollout)}</div>
${renderSegmentKeys(segmentKeysOf(rule), flagKey, ruleIndex, rollout, form)}
<form method="post" action="${escapeHtml(form.action)}">${form.baseVersionInput}${form.stateInputs}
<div class="form-row">
<input type="hidden" name="ruleIndex" value="${escapeHtml(index)}">
<label>Percentage <input type="number" name="percentage" min="0" max="100" step="0.01" value="${escapeHtml(String(rollout?.percentage ?? 0))}"></label>
<label>Bucket by <input type="text" name="bucketBy" value="${escapeHtml(rollout?.bucketBy ?? 'userId')}"></label>
<label>Salt <input type="text" name="salt" value="${escapeHtml(rollout?.salt ?? '')}"></label>
<button type="submit" name="field" value="setRollout">Save rollout</button>
</div>
</form>${remove}
</li>`;
};

/**
 * One row per rule, each holding its own rollout form and, when the rule targets a segment, its own
 * Detach confirmation. Every control carries that rule's index, so the row's confirmations name and
 * remove the same rule they sit on.
 */
export const renderRolloutForms = (flag: FlagDefinitionView, form: WriteFormContext): string => {
  if (flag.rules.length === 0) return '';
  const rows = flag.rules.map((rule, ruleIndex) => renderRuleRollout(rule, flag.key, ruleIndex, form)).join('\n');
  return `<details class="rollouts"><summary>Rollout</summary>
<div class="stack">
<ul class="rollout-list">
${rows}
</ul>
</div>
</details>`;
};
