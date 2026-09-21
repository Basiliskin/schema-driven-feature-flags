import type { FlagDefinitionView } from '../../application/browse-environment.js';
import type { PublishedSegmentsView } from '../../application/list-published-segments.js';
import { withUrlState, type DashboardUrlState } from '../url-state.js';
import { renderConfirmation } from './confirm-dialog.js';
import { escapeHtml, flagPath } from './escape.js';
import { dialogId } from './modal-dialog.js';
import { renderRolloutForms } from './rollout-form.js';
import { renderSegmentAttachForm } from './segment-attach-form.js';
import { stateInputs, type WriteFormContext } from './state-fields.js';

export interface EditDraft {
  readonly key: string;
  readonly enabled?: boolean;
  readonly defaultJson?: string;
  readonly rulesJson?: string;
  readonly segmentKey?: string;
  /** The attached value exactly as typed, so a rejected submission re-renders it rather than its decoded form. */
  readonly segmentValue?: string;
  readonly message: string;
  readonly issues: readonly string[];
}

export interface EditContext {
  readonly environment: string;
  readonly baseVersion: number;
  /** The view to come back to after a write; every form below carries it so a submit does not reset the page. */
  readonly urlState: DashboardUrlState;
  readonly draft?: EditDraft;
  /** Every segment published in the Environment, loaded by the route and offered by the attach form. */
  readonly publishedSegments?: PublishedSegmentsView;
}

export const renderDraftError = (draft: { readonly message: string; readonly issues: readonly string[] }): string => {
  const issues =
    draft.issues.length === 0 ? '' : `<ul>${draft.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`;
  return `<div class="notice error" role="alert"><p>${escapeHtml(draft.message)}</p>${issues}</div>`;
};

const renderDefaultControl = (flag: FlagDefinitionView, draft: EditDraft | undefined): string => {
  const text = draft?.defaultJson ?? JSON.stringify(flag.defaultValue, null, 2);
  return `<label>Default JSON <textarea name="default" rows="4">${escapeHtml(text)}</textarea></label>
<div class="actions"><button type="submit" class="button-secondary" name="field" value="default">Save default</button></div>`;
};

// Collapsed unless the operator is fixing a rejected rules draft, so long rule lists don't crowd a phone screen.
const renderRulesControl = (flag: FlagDefinitionView, draft: EditDraft | undefined): string => {
  const text = draft?.rulesJson ?? JSON.stringify(flag.rules, null, 2);
  return `<details${draft?.rulesJson === undefined ? '' : ' open'}><summary>Edit rules</summary>
<div class="stack">
<label>Rules JSON <textarea name="rules" rows="4">${escapeHtml(text)}</textarea></label>
<div class="actions"><button type="submit" class="button-secondary" name="field" value="rules">Save rules</button></div>
</div>
</details>`;
};

const baseVersionInput = (context: EditContext): string =>
  `<input type="hidden" name="baseVersion" value="${String(context.baseVersion)}">`;

const writeFormContext = (flag: FlagDefinitionView, context: EditContext): WriteFormContext => ({
  action: withUrlState(flagPath(context.environment, flag.key), context.urlState),
  baseVersionInput: baseVersionInput(context),
  stateInputs: stateInputs(context.urlState),
});

const renderDeleteControl = (flag: FlagDefinitionView, form: WriteFormContext): string =>
  renderConfirmation(
    {
      id: dialogId('confirm-delete', flag.key),
      title: `Delete ${flag.key}`,
      prompt: `Delete <code>${escapeHtml(flag.key)}</code>? This publishes a new version without it.`,
      triggerLabel: 'Delete',
      confirmLabel: `Delete ${flag.key}`,
      field: 'delete',
    },
    form,
  );

export const renderFeatureEditForm = (flag: FlagDefinitionView, context: EditContext): string => {
  const draft = context.draft?.key === flag.key ? context.draft : undefined;
  const enabled = draft?.enabled ?? flag.enabled;
  const form = writeFormContext(flag, context);
  return `${draft === undefined ? '' : renderDraftError(draft)}<form method="post" action="${escapeHtml(form.action)}" class="stack">
${form.baseVersionInput}${form.stateInputs}
<div class="form-row"><label class="check"><input type="checkbox" name="enabled"${enabled ? ' checked' : ''}> Enabled</label>
<button type="submit" name="field" value="enabled">Save enabled</button></div>
${flag.type === 'config' ? renderDefaultControl(flag, draft) : ''}
${renderRulesControl(flag, draft)}
</form>
${renderRolloutForms(flag, form)}
${renderSegmentAttachForm(flag, {
    ...form,
    segments: context.publishedSegments ?? { status: 'unavailable' },
    ...(draft === undefined ? {} : { draft }),
  })}
${renderDeleteControl(flag, form)}`;
};
