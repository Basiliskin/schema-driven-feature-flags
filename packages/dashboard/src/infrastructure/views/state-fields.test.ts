import { describe, expect, it } from 'vitest';
import { parsePendingChangeSet, type PendingChangeSet } from '../../domain/pending-change-set.js';
import { NO_URL_STATE } from '../url-state.js';
import { PENDING_FIELD, pendingInputs, stateInputs } from './state-fields.js';

describe('stateInputs', () => {
  it('renders nothing when every value is its default', () => {
    expect(stateInputs(NO_URL_STATE)).toBe('');
  });

  it('renders one hidden input per non-default value', () => {
    expect(stateInputs({ filter: 'dark', openFlags: ['a', 'b'], page: 3, pageSize: 5 })).toBe(
      '<input type="hidden" name="filter" value="dark">' +
        '<input type="hidden" name="open" value="a,b">' +
        '<input type="hidden" name="page" value="3">' +
        '<input type="hidden" name="pageSize" value="5">',
    );
  });

  it('escapes a value that would otherwise break out of the attribute', () => {
    expect(stateInputs({ filter: '"><script>x' })).toBe(
      '<input type="hidden" name="filter" value="&quot;&gt;&lt;script&gt;x">',
    );
  });

  it('keeps a space a space rather than the + a query string spells it with', () => {
    expect(stateInputs({ filter: 'dark mode' })).toBe('<input type="hidden" name="filter" value="dark mode">');
  });
});

describe('pendingInputs', () => {
  const PENDING: PendingChangeSet = { baseVersion: 4, snapshot: { features: { 'dark-mode': { enabled: true } }, note: `it's "quoted"\n` } };
  const valueOf = (html: string): string => /value="([^"]*)"/.exec(html)?.[1] ?? '';

  it('renders nothing when no edits are staged', () => {
    expect(pendingInputs(undefined)).toBe('');
  });

  it('renders one hidden input named for the pending field', () => {
    const html = pendingInputs(PENDING);

    expect(html).toMatch(new RegExp(`^<input type="hidden" name="${PENDING_FIELD}" value="[^"]+">$`));
  });

  it('carries the set through an HTML attribute and back without loss', () => {
    const value = valueOf(pendingInputs(PENDING)).replaceAll('&#39;', "'");

    expect(parsePendingChangeSet(value)).toEqual(PENDING);
  });
});
