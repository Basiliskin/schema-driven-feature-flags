import { serializePendingChangeSet, type PendingChangeSet } from '../../domain/pending-change-set.js';
import { serialiseUrlState, type DashboardUrlState } from '../url-state.js';
import { escapeHtml } from './escape.js';

/**
 * The current filter and open rows as hidden inputs. A write POST re-renders the page in place rather than
 * redirecting, so state the form does not submit is simply lost; defaults are omitted, exactly as they are
 * omitted from a URL.
 */
export const stateInputs = (state: Partial<DashboardUrlState>): string =>
  [...new URLSearchParams(serialiseUrlState(state))]
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');

export const PENDING_FIELD = 'pending';

/** The operator's staged edits, echoed by every form so the draft survives whichever one they submit next. */
export const pendingInputs = (pending: PendingChangeSet | undefined): string =>
  pending === undefined
    ? ''
    : `<input type="hidden" name="${PENDING_FIELD}" value="${escapeHtml(serializePendingChangeSet(pending))}">`;

/** What every form that writes a change needs: where to post, which version it was built from, the view to come back to, and the staged draft. */
export interface WriteFormContext {
  readonly action: string;
  readonly baseVersionInput: string;
  readonly stateInputs: string;
  readonly pendingInputs: string;
}
