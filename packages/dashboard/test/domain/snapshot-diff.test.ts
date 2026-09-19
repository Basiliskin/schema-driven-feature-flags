import { describe, expect, it } from 'vitest';
import { diffFlags, type FlagState } from '../../src/domain/snapshot-diff.js';

const flag = (key: string, overrides: Partial<FlagState> = {}): FlagState => ({
  key,
  type: 'boolean',
  enabled: true,
  defaultValue: true,
  rules: [],
  ...overrides,
});

describe('diffFlags', () => {
  it('is empty when nothing changed', () => {
    expect(diffFlags([flag('a')], [flag('a')])).toEqual([]);
  });

  it('reports added and removed flags, sorted by key', () => {
    const b = flag('b');
    const a = flag('a');
    expect(diffFlags([b], [a])).toEqual([
      { kind: 'added', key: 'a', after: a },
      { kind: 'removed', key: 'b', before: b },
    ]);
  });

  it('lists each changed field with its before and after values', () => {
    const before = flag('limits', { type: 'config', enabled: false, defaultValue: { max: 3 } });
    const after = flag('limits', { type: 'config', enabled: true, defaultValue: { max: 9 }, rules: [{ when: {} }] });
    expect(diffFlags([before], [after])).toEqual([
      {
        kind: 'changed',
        key: 'limits',
        fields: [
          { field: 'enabled', before: false, after: true },
          { field: 'default', before: { max: 3 }, after: { max: 9 } },
          { field: 'rules', before: [], after: [{ when: {} }] },
        ],
      },
    ]);
  });

  it('ignores a boolean flag default, which only mirrors enabled', () => {
    const changes = diffFlags([flag('a', { enabled: true, defaultValue: true })], [flag('a', { enabled: false, defaultValue: false })]);
    expect(changes).toEqual([{ kind: 'changed', key: 'a', fields: [{ field: 'enabled', before: true, after: false }] }]);
  });

  it('reports a type change', () => {
    const changes = diffFlags([flag('a')], [flag('a', { type: 'config', defaultValue: 1 })]);
    expect(changes[0]).toMatchObject({ kind: 'changed', fields: [{ field: 'type' }, { field: 'default', after: 1 }] });
  });
});
