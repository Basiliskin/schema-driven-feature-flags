import { describe, expect, it } from 'vitest';
import { renderChangesFragment } from './changes-dialog.js';
import { renderMergeFragment } from './merge-dialog.js';

describe('renderChangesFragment', () => {
  const changed = { status: 'changed', environment: 'production', from: 3, to: 5 } as const;

  it('explains when the snapshots cannot be compared, and names nobody when the publisher is unknown', () => {
    const html = renderChangesFragment(changed);
    expect(html).toContain('From version 3 to version 5, published.</p>');
    expect(html).toContain('can’t be compared one by one');
  });

  it('says when no flag changed and leaves out an empty reason', () => {
    const html = renderChangesFragment({
      ...changed,
      latest: { createdBy: 'bob', createdAt: '2026-09-19T12:00:00.000Z', reason: '' },
      changes: [],
    });
    expect(html).toContain('published by bob · <time');
    expect(html).not.toContain(' — ');
    expect(html).toContain('No flag changed');
  });

  it('shows a dash for a value one side does not have', () => {
    const html = renderChangesFragment({
      ...changed,
      changes: [{ kind: 'changed', key: 'a', fields: [{ field: 'default', before: undefined, after: 3 }] }],
    });
    expect(html).toContain('<td class="diff-before"><span class="muted">—</span></td>');
  });

  it('describes added and removed config flags with their defaults', () => {
    const flag = { key: 'a', type: 'config', enabled: true, defaultValue: { max: 1 }, rules: [] } as const;
    const html = renderChangesFragment({
      ...changed,
      changes: [
        { kind: 'added', key: 'a', after: flag },
        { kind: 'removed', key: 'b', before: { ...flag, key: 'b', enabled: false } },
      ],
    });
    expect(html).toContain('config · On · default <code>{&quot;max&quot;:1}</code>');
    expect(html).toContain('Was config · Off');
  });
});

describe('renderMergeFragment', () => {
  it('explains an unreadable snapshot', () => {
    expect(renderMergeFragment({ status: 'unavailable' })).toContain('couldn’t be read');
  });

  it('says a draft with no overlapping changes can be published as is', () => {
    expect(renderMergeFragment({ status: 'ready', from: 3, to: 5, entries: [] })).toContain('can be published on top of version 5 as is');
  });

  it('pluralises the conflict count and offers no choice for agreed changes', () => {
    const conflict = { status: 'conflict', base: 1, mine: 2, theirs: 3 } as const;
    const html = renderMergeFragment({
      status: 'ready',
      from: 3,
      to: 5,
      entries: [
        { key: 'a', ...conflict },
        { key: 'b', ...conflict },
        { key: 'c', status: 'same', base: 1, mine: 2, theirs: 2 },
      ],
    });
    expect(html).toContain('<strong>2 flags were changed on both sides</strong>');
    expect(html).not.toContain('name="pick:c"');
  });

  it('notes when every overlapping change was already picked', () => {
    const html = renderMergeFragment({
      status: 'ready',
      from: 3,
      to: 5,
      entries: [{ key: 'a', status: 'theirs', base: 1, mine: 1, theirs: 2 }],
    });
    expect(html).toContain('Changes on only one side are already picked.</p>');
    expect(html).not.toContain('changed on both sides');
  });

  it('renders a combined flag without a whole-flag choice', () => {
    const html = renderMergeFragment({
      status: 'ready',
      from: 3,
      to: 5,
      entries: [
        {
          key: 'a',
          status: 'combined',
          base: {},
          mine: { enabled: true },
          theirs: { rules: [] },
          fields: [{ field: 'enabled', status: 'mine', base: undefined, mine: true, theirs: undefined }],
        },
      ],
    });
    expect(html).toContain('combined field by field');
    expect(html).not.toContain('name="pick:a"');
    expect(html).toContain('name="pick:a:enabled" value="mine" checked');
  });
});
