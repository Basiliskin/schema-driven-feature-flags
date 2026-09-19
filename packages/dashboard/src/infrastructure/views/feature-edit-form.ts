import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { environmentPath, escapeHtml } from './escape.js';

export interface EditDraft {
  readonly key: string;
  readonly enabled?: boolean;
  readonly defaultJson?: string;
  readonly rulesJson?: string;
  readonly message: string;
  readonly issues: readonly string[];
}

export interface EditContext {
  readonly environment: string;
  readonly baseVersion: number;
  readonly draft?: EditDraft;
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

// A <details> disclosure is the confirmation step, so the page needs no JavaScript confirm().
const renderDeleteControl = (flag: FlagDefinitionView, action: string, context: EditContext): string =>
  `<details class="danger-zone"><summary>Delete</summary>
<form method="post" action="${escapeHtml(action)}">
${baseVersionInput(context)}
<p>Delete ${escapeHtml(flag.key)}? This publishes a new version without it.</p>
<button type="submit" class="button-danger" name="field" value="delete">Delete ${escapeHtml(flag.key)}</button>
</form>
</details>`;

export const renderFeatureEditForm = (flag: FlagDefinitionView, context: EditContext): string => {
  const draft = context.draft?.key === flag.key ? context.draft : undefined;
  const enabled = draft?.enabled ?? flag.enabled;
  const action = `${environmentPath(context.environment)}/features/${encodeURIComponent(flag.key)}`;
  return `${draft === undefined ? '' : renderDraftError(draft)}<form method="post" action="${escapeHtml(action)}" class="stack">
${baseVersionInput(context)}
<div class="form-row"><label class="check"><input type="checkbox" name="enabled"${enabled ? ' checked' : ''}> Enabled</label>
<button type="submit" name="field" value="enabled">Save enabled</button></div>
${flag.type === 'config' ? renderDefaultControl(flag, draft) : ''}
${renderRulesControl(flag, draft)}
</form>
${renderDeleteControl(flag, action, context)}`;
};
