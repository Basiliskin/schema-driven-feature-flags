/** The parts of a flag an operator can change; FlagDefinitionView satisfies it structurally. */
export interface FlagState {
  readonly key: string;
  readonly type: 'boolean' | 'config';
  readonly enabled: boolean;
  readonly defaultValue: unknown;
  readonly rules: readonly unknown[];
}

export type FlagField = 'type' | 'enabled' | 'default' | 'rules';

export interface FieldChange {
  readonly field: FlagField;
  readonly before: unknown;
  readonly after: unknown;
}

export type FlagChange =
  | { readonly kind: 'added'; readonly key: string; readonly after: FlagState }
  | { readonly kind: 'removed'; readonly key: string; readonly before: FlagState }
  | { readonly kind: 'changed'; readonly key: string; readonly fields: readonly FieldChange[] };

const fieldValue = (flag: FlagState, field: FlagField): unknown => {
  switch (field) {
    case 'type':
      return flag.type;
    case 'enabled':
      return flag.enabled;
    case 'default':
      // A boolean flag's default mirrors `enabled`, so only config defaults are compared.
      return flag.type === 'config' ? flag.defaultValue : undefined;
    case 'rules':
      return flag.rules;
  }
};

const FIELDS: readonly FlagField[] = ['type', 'enabled', 'default', 'rules'];

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Per-flag differences from `before` to `after`, sorted by key; unchanged flags are left out. */
export function diffFlags(before: readonly FlagState[], after: readonly FlagState[]): FlagChange[] {
  const old = new Map(before.map((flag) => [flag.key, flag]));
  const next = new Map(after.map((flag) => [flag.key, flag]));
  const keys = [...new Set([...old.keys(), ...next.keys()])].sort();
  return keys.flatMap((key): FlagChange[] => {
    const from = old.get(key);
    const to = next.get(key);
    // Every key comes from one of the two maps, so at most one side is missing.
    if (from === undefined) return [{ kind: 'added', key, after: to as FlagState }];
    if (to === undefined) return [{ kind: 'removed', key, before: from }];
    const fields = FIELDS.flatMap((field): FieldChange[] => {
      const a = fieldValue(from, field);
      const b = fieldValue(to, field);
      return sameJson(a, b) ? [] : [{ field, before: a, after: b }];
    });
    return fields.length === 0 ? [] : [{ kind: 'changed', key, fields }];
  });
}
