import type { FlagType } from '../../domain/flag-edit.js';
import { withUrlState, type DashboardUrlState } from '../url-state.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderDraftError } from './feature-edit-form.js';
import { stateInputs } from './state-fields.js';

export interface CreateDraft {
  readonly key: string;
  readonly type: FlagType;
  readonly enabled: boolean;
  readonly defaultJson: string;
  readonly message: string;
  readonly issues: readonly string[];
}

export interface NewFlagContext {
  readonly environment: string;
  readonly baseVersion: number;
  readonly urlState: DashboardUrlState;
  readonly draft?: CreateDraft;
}

const typeOption = (type: FlagType, selected: FlagType): string =>
  `<option value="${type}"${type === selected ? ' selected' : ''}>${type}</option>`;

export const renderNewFlagForm = (context: NewFlagContext): string => {
  const { draft } = context;
  const type = draft?.type ?? 'boolean';
  const action = withUrlState(`${environmentPath(context.environment)}/features`, context.urlState);
  // Opened when a create draft was rejected, so the operator sees the error next to their input.
  return `<details class="card"${draft === undefined ? '' : ' open'}>
<summary>New flag</summary>
${draft === undefined ? '' : renderDraftError(draft)}<form method="post" action="${escapeHtml(action)}" class="stack">
<input type="hidden" name="baseVersion" value="${String(context.baseVersion)}">${stateInputs(context.urlState)}
<div class="form-row">
<label>Key <input type="text" name="key" required value="${escapeHtml(draft?.key ?? '')}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
<label>Type <select name="type">${typeOption('boolean', type)}${typeOption('config', type)}</select></label>
</div>
<label class="check"><input type="checkbox" name="enabled"${draft?.enabled === true ? ' checked' : ''}> Enabled</label>
<label>Default JSON (config flags only) <textarea name="default" rows="3">${escapeHtml(draft?.defaultJson ?? 'null')}</textarea></label>
<div class="actions"><button type="submit">Create flag</button></div>
</form>
</details>`;
};
