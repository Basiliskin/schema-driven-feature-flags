import { describe, expect, it } from 'vitest';
import { dialogId, renderDialogTrigger, renderModalDialog } from './modal-dialog.js';
import { STYLESHEET } from './stylesheet.js';

const dialog = (overrides: Partial<Parameters<typeof renderModalDialog>[0]> = {}) =>
  renderModalDialog({
    id: 'publish-dialog',
    headingId: 'publish-heading',
    title: 'Publish a new version',
    body: '<p>Body</p>',
    ...overrides,
  });

describe('renderModalDialog', () => {
  it('names itself with the heading the page script and the e2e selectors key off', () => {
    const html = dialog();

    expect(html).toContain('<dialog id="publish-dialog" class="modal-dialog" aria-labelledby="publish-heading">');
    expect(html).toContain('<h2 id="publish-heading">Publish a new version</h2>');
    expect(html).toContain('<p>Body</p>');
  });

  it('carries the close control the enhanced overlay needs', () => {
    expect(dialog()).toContain('<form method="dialog"><button type="submit" class="button-secondary" aria-label="Close">Close</button></form>');
  });

  it('omits data-open-on-load entirely when it should stay shut, since the script tests for presence', () => {
    expect(dialog()).not.toContain('data-open-on-load');
    expect(dialog({ openOnLoad: false })).not.toContain('data-open-on-load');
  });

  it('emits data-open-on-load as a bare attribute when it should open', () => {
    expect(dialog({ openOnLoad: true })).toContain('aria-labelledby="publish-heading" data-open-on-load>');
  });

  it('escapes a title that contains markup', () => {
    expect(dialog({ title: 'a"<b' })).toContain('<h2 id="publish-heading">a&quot;&lt;b</h2>');
  });

  it('is styled by the one served sheet, inline by default and as an overlay once enhanced', () => {
    expect(STYLESHEET).toContain('.modal-dialog {');
    expect(STYLESHEET).toContain('.modal-dialog.is-enhanced {');
    expect(STYLESHEET).toContain('.modal-dialog::backdrop {');
    expect(STYLESHEET).toContain('.modal-dialog:not(.is-enhanced) .dialog-head form {');
  });
});

describe('renderDialogTrigger', () => {
  it('stays hidden until the page script confirms the dialog can open', () => {
    expect(renderDialogTrigger({ dialogId: 'publish-dialog', label: 'Publish new version' })).toBe(
      '<button type="button" data-open-dialog="publish-dialog" hidden>Publish new version</button>',
    );
  });

  it('escapes a label that contains markup', () => {
    expect(renderDialogTrigger({ dialogId: 'publish-dialog', label: 'a"<b' })).toContain('>a&quot;&lt;b</button>');
  });

  it('is not emitted by the dialog itself, so a dialog without one renders no button', () => {
    expect(dialog()).not.toContain('data-open-dialog');
    expect(dialog()).not.toContain('type="button"');
  });
});

describe('dialogId', () => {
  it('leaves a plain key untouched and joins the parts', () => {
    expect(dialogId('confirm-delete', 'new-dashboard')).toBe('confirm-delete_new-dashboard');
    expect(dialogId('confirm-detach', 'checkout', 3)).toBe('confirm-detach_checkout_3');
  });

  it('escapes every character an id cannot carry, so a dotted or slashed key still selects', () => {
    expect(dialogId('confirm-delete', 'checkout.limits/v2')).toBe('confirm-delete_checkout_002elimits_002fv2');
    expect(dialogId('confirm-delete', 'a b')).toBe('confirm-delete_a_0020b');
  });

  it('gives two subjects that differ only in a separator two different ids', () => {
    expect(dialogId('x', 'a_b')).not.toBe(dialogId('x', 'a', 'b'));
    expect(dialogId('x', 'a-b', 'c')).not.toBe(dialogId('x', 'a', 'b-c'));
  });

  it('keeps case, since an id is compared exactly', () => {
    expect(dialogId('confirm-delete', 'Checkout')).toBe('confirm-delete_Checkout');
  });
});
