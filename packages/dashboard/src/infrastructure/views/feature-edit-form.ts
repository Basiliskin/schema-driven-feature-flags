import type { FlagDefinitionView } from '../../application/browse-environment.js';
import type { PublishedSegmentsView } from '../../application/list-published-segments.js';
import type { PendingChangeSet } from '../../domain/pending-change-set.js';
import { withUrlState, type DashboardUrlState } from '../url-state.js';
import { renderConfirmationParts } from './confirm-dialog.js';
import { escapeHtml, flagPath } from './escape.js';
import { dialogId } from './modal-dialog.js';
import { renderRolloutFields } from './rollout-form.js';
import { renderSegmentAttachFields } from './segment-attach-form.js';
import { pendingInputs, stateInputs, type WriteFormContext } from './state-fields.js';

export interface EditDraft {
  readonly key: string;
  readonly enabled?: boolean;
  readonly defaultJson?: string;
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
  /** The operator's staged edits, echoed by every form; `baseVersion` is then the version they started from. */
  readonly pending?: PendingChangeSet | undefined;
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
  return `<label>Default JSON <textarea name="default" rows="4">${escapeHtml(text)}</textarea></label>`;
};

const baseVersionInput = (context: EditContext): string =>
  `<input type="hidden" name="baseVersion" value="${String(context.baseVersion)}">`;

const writeFormContext = (flag: FlagDefinitionView, context: EditContext): WriteFormContext => ({
  action: withUrlState(flagPath(context.environment, flag.key), context.urlState),
  baseVersionInput: baseVersionInput(context),
  stateInputs: stateInputs(context.urlState),
  pendingInputs: pendingInputs(context.pending),
});

/**
 * Every editable part of a flag — Enabled, Default, every rule's rollout and detach, and Attach a segment —
 * lives in ONE form behind ONE Save button, so staging a change never means picking which of several
 * save buttons applies it. Save and Delete sit together at the top of the panel (Close is the dialog's own
 * header button, added where the panel is shown); Delete stays its own confirmed, immediately-published
 * action, since removing a whole flag is not a value you can quietly stage and reconsider like a field edit.
 */
export const renderFeatureEditForm = (flag: FlagDefinitionView, context: EditContext): string => {
  const draft = context.draft?.key === flag.key ? context.draft : undefined;
  const enabled = draft?.enabled ?? flag.enabled;
  const form = writeFormContext(flag, context);
  const formId = dialogId('edit-form', flag.key);
  const { trigger: deleteTrigger, dialog: deleteDialog } = renderConfirmationParts(
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
  return `${draft === undefined ? '' : renderDraftError(draft)}<div class="panel-head">
<button type="submit" form="${escapeHtml(formId)}" name="field" value="save">Save</button>
${deleteTrigger}
</div>
<form method="post" id="${escapeHtml(formId)}" action="${escapeHtml(form.action)}" class="stack">
${form.baseVersionInput}${form.stateInputs}${form.pendingInputs}
<label class="check"><input type="checkbox" name="enabled"${enabled ? ' checked' : ''}> Enabled</label>
${flag.type === 'config' ? renderDefaultControl(flag, draft) : ''}
${renderRolloutFields(flag)}
${renderSegmentAttachFields(flag, {
    segments: context.publishedSegments ?? { status: 'unavailable' },
    ...(draft === undefined ? {} : { draft }),
  })}
</form>
${deleteDialog}`;
};
