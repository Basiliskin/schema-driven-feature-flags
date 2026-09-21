import { describe, expect, it } from 'vitest';
import type { PendingReview } from '../../application/review-pending-change-set.js';
import type { FlagState } from '../../domain/snapshot-diff.js';
import { serializePendingChangeSet, type PendingChangeSet } from '../../domain/pending-change-set.js';
import { NO_URL_STATE } from '../url-state.js';
import { REVIEW_ACTIONS, renderReviewDialog, renderReviewTrigger, type ReviewContext } from './review-dialog.js';

const flag = (key: string, enabled: boolean): FlagState => ({ key, type: 'boolean', enabled, defaultValue: enabled, rules: [] });
const configFlag = (key: string, defaultValue: unknown): FlagState => ({
  key,
  type: 'config',
  enabled: true,
  defaultValue,
  rules: [],
});

const pending: PendingChangeSet = { baseVersion: 3, snapshot: { features: {} } };
const carried = serializePendingChangeSet(pending);

const context = (review: PendingReview, overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  environment: 'production',
  urlState: NO_URL_STATE,
  pending,
  review,
  openOnLoad: false,
  ...overrides,
});

const DIALOG_OPEN = (open: boolean) =>
  `<dialog id="review-dialog" class="modal-dialog" aria-labelledby="review-heading"${open ? ' data-open-on-load' : ''}>
<div class="dialog-head"><h2 id="review-heading">Review pending changes</h2>
<form method="dialog"><button type="submit" class="button-secondary" aria-label="Close">Close</button></form></div>`;

const FORM_OPEN = `<form method="post" action="/env/production/pending" class="stack">
<input type="hidden" name="pending" value="${carried}">`;

const UPDATE = '<button type="submit" name="field" value="update">Update</button>';
const PUBLISH_ANYWAY = '<button type="submit" name="field" value="publishAnyway">Publish anyway</button>';
const DISCARD = '<button type="submit" class="button-secondary" name="field" value="discard">Discard</button>';
const ACTIONS = (publish: string) => `<div class="actions">${publish}${DISCARD}</div>`;

const DRIFT_WARNING =
  '<p class="notice warning" data-version-drift>This environment has moved on since version 3, where your changes started. Publishing anyway replaces whatever was published since with your snapshot.</p>\n';

const CHANGED_ALPHA =
  '<li><div class="card-head"><span class="flag-key">alpha</span><span class="badge diff-changed">changed</span></div>\n<div class="table-wrap"><table class="diff-table"><thead><tr><th>Field</th><th>Published</th><th>Staged</th></tr></thead><tbody><tr><th scope="row">enabled</th><td class="diff-before"><code>true</code></td><td class="diff-after"><code>false</code></td></tr></tbody></table></div></li>';
const ADDED_BETA = '<li><div class="card-head"><span class="flag-key">beta</span><span class="badge diff-added">added</span></div></li>';
const REMOVED_GONE = '<li><div class="card-head"><span class="flag-key">gone</span><span class="badge diff-removed">removed</span></div></li>';

const dialog = (open: boolean, warning: string, list: string, publish: string) =>
  `${DIALOG_OPEN(open)}\n${warning}${FORM_OPEN}\n${list}\n${ACTIONS(publish)}\n</form>\n</dialog>`;

const list = (...items: string[]) => `<ul class="change-list">\n${items.join('\n')}\n</ul>`;

describe('renderReviewDialog', () => {
  it('lists every changed flag and offers Update and Discard when nothing has drifted', () => {
    const review: PendingReview = {
      baseFlags: [flag('alpha', true), flag('gone', true)],
      stagedFlags: [flag('alpha', false), flag('beta', true)],
      drifted: false,
    };

    expect(renderReviewDialog(context(review))).toBe(
      dialog(false, '', list(CHANGED_ALPHA, ADDED_BETA, REMOVED_GONE), UPDATE),
    );
  });

  it('warns about drift and keeps a working publish-anyway submit beside Discard', () => {
    const review: PendingReview = { baseFlags: [flag('alpha', true)], stagedFlags: [flag('alpha', false)], drifted: true };

    const html = renderReviewDialog(context(review));

    expect(html).toBe(dialog(false, DRIFT_WARNING, list(CHANGED_ALPHA), PUBLISH_ANYWAY));
    expect(html).not.toContain('disabled');
    expect(html).not.toMatch(/\shidden[\s>]/);
    expect(html).not.toContain('aria-hidden');
  });

  it('shows no warning without drift', () => {
    const html = renderReviewDialog(context({ baseFlags: [flag('alpha', true)], stagedFlags: [flag('alpha', false)], drifted: false }));

    expect(html).not.toContain('data-version-drift');
    expect(html).toContain(UPDATE);
    expect(html).not.toContain(PUBLISH_ANYWAY);
  });

  it('shows the net change once for a flag edited several times, and none when the edits cancel out', () => {
    const base = [configFlag('limits', { max: 3 })];

    const twice = renderReviewDialog(context({ baseFlags: base, stagedFlags: [configFlag('limits', { max: 9 })], drifted: false }));
    const cancelled = renderReviewDialog(context({ baseFlags: base, stagedFlags: [configFlag('limits', { max: 3 })], drifted: false }));

    expect(twice.match(/<li>/g)).toHaveLength(1);
    expect(twice).toContain(
      '<tr><th scope="row">default</th><td class="diff-before"><code>{&quot;max&quot;:3}</code></td><td class="diff-after"><code>{&quot;max&quot;:9}</code></td></tr>',
    );
    expect(cancelled).toBe(
      dialog(
        false,
        '',
        '<p class="muted">Your staged changes leave every flag as it was in version 3.</p>',
        UPDATE,
      ),
    );
  });

  it('marks a field that only one side has with a dash', () => {
    const review: PendingReview = {
      baseFlags: [flag('mode', true)],
      stagedFlags: [{ ...configFlag('mode', 'dark'), key: 'mode' }],
      drifted: false,
    };

    expect(renderReviewDialog(context(review))).toContain('<td class="diff-before"><span class="muted">—</span></td>');
  });

  it.each([
    ['the base version', { baseFlags: undefined, stagedFlags: [flag('a', true)], drifted: false }],
    ['the staged snapshot', { baseFlags: [flag('a', true)], stagedFlags: undefined, drifted: false }],
  ] as const)('says the flags cannot be compared when %s cannot be read', (_side, review) => {
    expect(renderReviewDialog(context(review))).toBe(
      dialog(
        false,
        '',
        '<p>Your staged snapshot or version 3 can’t be read, so the flags can’t be compared one by one.</p>',
        UPDATE,
      ),
    );
  });

  it('opens on load only when asked to', () => {
    const review: PendingReview = { baseFlags: [], stagedFlags: [], drifted: false };

    expect(renderReviewDialog(context(review, { openOnLoad: true }))).toContain(' data-open-on-load>');
    expect(renderReviewDialog(context(review))).not.toContain('data-open-on-load');
  });

  it('posts to the pending route carrying the page state in hidden fields', () => {
    const html = renderReviewDialog(
      context({ baseFlags: [], stagedFlags: [], drifted: false }, { urlState: { ...NO_URL_STATE, filter: 'cart' } }),
    );

    expect(html).toContain('<form method="post" action="/env/production/pending?filter=cart" class="stack">');
    expect(html).toContain('<input type="hidden" name="filter" value="cart">');
  });

  it('names its three actions after the values the server dispatches on', () => {
    expect(REVIEW_ACTIONS).toEqual({ update: 'update', publishAnyway: 'publishAnyway', discard: 'discard' });
  });
});

describe('renderReviewTrigger', () => {
  it('is a script-revealed button for the review dialog', () => {
    expect(renderReviewTrigger()).toBe('<button type="button" data-open-dialog="review-dialog" hidden>Review pending changes</button>');
  });
});
