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

/**
 * The attached-segment info for one rule — its keys and the share of members the rule reaches (a rule with
 * no rollout reaches all of them) — plus, when it targets a segment, a "Detach" checkbox. Checking it is
 * staged like every other change here and applied only when the operator clicks the one Save button.
 */
const renderSegmentBlockWithShare = (keys: readonly string[], ruleIndex: number, rollout: RolloutView | undefined): string => {
  if (keys.length === 0) return '';
  const percentage = String(rollout?.percentage ?? 100);
  const markedUp = keys.map((key) => `<code>${escapeHtml(key)}</code>`).join(' ');
  return `<ul class="rule-segments">
<li class="rule-segment">Segments ${markedUp}
<span class="badge badge-segment">${escapeHtml(percentage)}% of members</span>
</li>
</ul>
<label class="check"><input type="checkbox" name="${escapeHtml(`detach_${String(ruleIndex)}`)}"> Detach</label>`;
};

const renderRuleRollout = (rule: unknown, ruleIndex: number): string => {
  const rollout = readRollout(rule);
  const index = String(ruleIndex);
  const label = String(ruleIndex + 1);
  const segments = renderSegmentBlockWithShare(segmentKeysOf(rule), ruleIndex, rollout);
  return `<li class="rule-rollout">
<div class="rule-head">
<span class="rule-label">Rule ${label}</span>${renderRolloutBadge(rollout)}
</div>
${segments}
<div class="form-row">
<label class="check"><input type="checkbox" name="${escapeHtml(`rollout_${index}`)}"${rollout === undefined ? '' : ' checked'}> Rollout</label>
<label>Percentage <input type="number" name="${escapeHtml(`percentage_${index}`)}" min="0" max="100" step="0.01" value="${escapeHtml(String(rollout?.percentage ?? 0))}"></label>
<label>Bucket by <input type="text" name="${escapeHtml(`bucketBy_${index}`)}" value="${escapeHtml(rollout?.bucketBy ?? 'userId')}"></label>
<label>Salt <input type="text" name="${escapeHtml(`salt_${index}`)}" value="${escapeHtml(rollout?.salt ?? '')}" placeholder="defaults to rule-${escapeHtml(index)}"></label>
</div>
</li>`;
};

/**
 * The segments named across every rule, in rule order, deduplicated. Shown in the summary so which
 * segment(s) this flag's rollout applies to is visible without expanding the section.
 */
const allSegmentKeys = (flag: FlagDefinitionView): readonly string[] => {
  const keys = flag.rules.flatMap((rule) => segmentKeysOf(rule));
  return [...new Set(keys)];
};

/**
 * The rollout fields of every rule — no `<form>`, no submit of its own. Nested inside the single flag-edit
 * form (see feature-edit-form.ts), so every rule's Percentage/Bucket by/Salt, its Rollout toggle and its
 * Detach checkbox are staged together with everything else on the one Save click. `ruleCount` tells the
 * server how many `rollout_<i>`/`detach_<i>`-style fields to expect.
 */
export const renderRolloutFields = (flag: FlagDefinitionView): string => {
  if (flag.rules.length === 0) return '';
  const rows = flag.rules.map((rule, ruleIndex) => renderRuleRollout(rule, ruleIndex)).join('\n');
  const segments = allSegmentKeys(flag);
  const segmentsLabel = segments.length === 0 ? '' : ` <span class="muted">· ${escapeHtml(segments.join(', '))}</span>`;
  return `<input type="hidden" name="ruleCount" value="${escapeHtml(String(flag.rules.length))}">
<details class="rollouts"><summary>Rollout${segmentsLabel}</summary>
<div class="stack">
<ul class="rollout-list">
${rows}
</ul>
</div>
</details>`;
};
