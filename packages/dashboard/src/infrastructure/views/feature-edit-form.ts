import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { environmentPath, escapeHtml } from './escape.js';

export interface EditDraft {
  readonly key: string;
  readonly enabled?: boolean;
  readonly defaultJson?: string;
  readonly message: string;
  readonly issues: readonly string[];
}

export interface EditContext {
  readonly environment: string;
  readonly baseVersion: number;
  readonly draft?: EditDraft;
}

const renderError = (draft: EditDraft): string => {
  const issues =
    draft.issues.length === 0 ? '' : `<ul>${draft.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`;
  return `<div class="notice error" role="alert"><p>${escapeHtml(draft.message)}</p>${issues}</div>`;
};

const renderDefaultControl = (flag: FlagDefinitionView, draft: EditDraft | undefined): string => {
  const text = draft?.defaultJson ?? JSON.stringify(flag.defaultValue, null, 2);
  return `<label>Default JSON <textarea name="default" rows="4">${escapeHtml(text)}</textarea></label>
<button type="submit" name="field" value="default">Save default</button>`;
};

export const renderFeatureEditForm = (flag: FlagDefinitionView, context: EditContext): string => {
  const draft = context.draft?.key === flag.key ? context.draft : undefined;
  const enabled = draft?.enabled ?? flag.enabled;
  const action = `${environmentPath(context.environment)}/features/${encodeURIComponent(flag.key)}`;
  return `<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="baseVersion" value="${String(context.baseVersion)}">
<label><input type="checkbox" name="enabled"${enabled ? ' checked' : ''}> Enabled</label>
<button type="submit" name="field" value="enabled">Save enabled</button>
${flag.type === 'config' ? renderDefaultControl(flag, draft) : ''}
</form>${draft === undefined ? '' : renderError(draft)}`;
};
