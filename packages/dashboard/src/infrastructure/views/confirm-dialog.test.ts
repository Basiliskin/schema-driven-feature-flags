import { describe, expect, it } from 'vitest';
import { renderConfirmation } from './confirm-dialog.js';
import type { WriteFormContext } from './state-fields.js';

const FORM: WriteFormContext = {
  action: '/env/production/features/checkout',
  baseVersionInput: '<input type="hidden" name="baseVersion" value="7">',
  stateInputs: '<input type="hidden" name="filter" value="dark">',
  pendingInputs: '',
};

const CONFIRMATION = {
  id: 'confirm-delete_checkout',
  title: 'Delete checkout',
  prompt: 'Delete <code>checkout</code>?',
  triggerLabel: 'Delete',
  confirmLabel: 'Delete checkout',
  field: 'delete',
};

describe('renderConfirmation', () => {
  it('puts the real submit inside the dialog and leaves only a hidden trigger outside it', () => {
    const html = renderConfirmation(CONFIRMATION, FORM);
    const [trigger, dialog] = html.split('\n<dialog') as [string, string];

    expect(trigger).toBe('<button type="button" data-open-dialog="confirm-delete_checkout" hidden>Delete</button>');
    expect(trigger).not.toContain('name="field"');
    expect(dialog).toContain('<button type="submit" class="button-danger" name="field" value="delete">Delete checkout</button>');
    expect(dialog).toContain('<h2 id="confirm-delete_checkout-heading">Delete checkout</h2>');
  });

  it('carries the write form’s action, base version and URL state, so the POST is the one it replaced', () => {
    const html = renderConfirmation(CONFIRMATION, FORM);

    expect(html).toContain('<form method="post" action="/env/production/features/checkout"><input type="hidden" name="baseVersion" value="7"><input type="hidden" name="filter" value="dark">');
  });

  it('adds the caller’s hidden inputs after the standard ones, and none when there are none', () => {
    const withIndex = renderConfirmation(
      { ...CONFIRMATION, field: 'detachSegment', hiddenInputs: '<input type="hidden" name="ruleIndex" value="2">' },
      FORM,
    );

    expect(withIndex).toContain('name="filter" value="dark"><input type="hidden" name="ruleIndex" value="2">\n<p>');
    expect(renderConfirmation(CONFIRMATION, FORM)).toContain('name="filter" value="dark">\n<p>');
  });

  it('never opens on load, so a confirmation only ever appears because the operator asked for it', () => {
    expect(renderConfirmation(CONFIRMATION, FORM)).not.toContain('data-open-on-load');
  });

  it('escapes the action, the confirm label and the field, and takes the prompt as ready-made markup', () => {
    const html = renderConfirmation(
      { ...CONFIRMATION, confirmLabel: 'Delete <b>', field: '"><script>', prompt: 'Delete <code>&lt;b&gt;</code>?' },
      { ...FORM, action: '/env/production/features/%22%3E' },
    );

    expect(html).toContain('action="/env/production/features/%22%3E"');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;">Delete &lt;b&gt;</button>');
    expect(html).toContain('<p>Delete <code>&lt;b&gt;</code>?</p>');
    expect(html).not.toContain('<script>');
  });
});
