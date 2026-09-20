import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { escapeHtml } from './escape.js';

/** The attach fields of a rejected submission, echoed back so the operator keeps what they typed. */
export interface AttachDraft {
  readonly segmentKey?: string;
  readonly memberAttribute?: string;
  readonly segmentValue?: string;
}

export interface AttachContext {
  readonly action: string;
  readonly baseVersionInput: string;
  /** Segment Keys the current snapshot already references, offered as suggestions. */
  readonly segmentKeys: readonly string[];
  readonly draft?: AttachDraft;
}

const DEFAULT_MEMBER_ATTRIBUTE = 'userId';

const listId = (flagKey: string): string => `attach-segments-${flagKey}`;

// A datalist suggests the keys already in use while still accepting a key typed by hand, so a segment
// created for a fresh environment — referenced by nothing yet — can still be attached.
const renderSuggestions = (flagKey: string, segmentKeys: readonly string[]): string =>
  segmentKeys.length === 0
    ? ''
    : `<datalist id="${escapeHtml(listId(flagKey))}">${segmentKeys
        .map((key) => `<option value="${escapeHtml(key)}"></option>`)
        .join('')}</datalist>`;

const renderValueControl = (flag: FlagDefinitionView, draft: AttachDraft | undefined): string =>
  flag.type === 'config'
    ? `<label>Value for members <input type="text" name="value" value="${escapeHtml(draft?.segmentValue ?? '')}"></label>
<p class="muted">A plain word, a number or true/false is fine — you do not have to type JSON.</p>`
    : '';

export const renderSegmentAttachForm = (flag: FlagDefinitionView, context: AttachContext): string => {
  const { draft, segmentKeys } = context;
  const suggestions = renderSuggestions(flag.key, segmentKeys);
  const list = suggestions === '' ? '' : ` list="${escapeHtml(listId(flag.key))}"`;
  return `<details class="segment-attach"><summary>Attach a segment</summary>
<form method="post" action="${escapeHtml(context.action)}" class="stack">
${context.baseVersionInput}
${suggestions}<label>Segment key <input type="text" name="segmentKey"${list} value="${escapeHtml(draft?.segmentKey ?? '')}" required></label>
<label>Member attribute <input type="text" name="memberAttribute" value="${escapeHtml(draft?.memberAttribute ?? DEFAULT_MEMBER_ATTRIBUTE)}" required></label>
<p class="muted">Use the attribute the segment was uploaded with; members are matched on it.</p>
${renderValueControl(flag, draft)}
<div class="actions"><button type="submit" name="field" value="attachSegment">Attach segment</button></div>
</form>
</details>`;
};
