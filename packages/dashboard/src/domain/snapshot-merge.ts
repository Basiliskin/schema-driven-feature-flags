/** A feature's raw JSON definition in one snapshot; `undefined` means the snapshot doesn't have it. */
type Definition = unknown;

export type MergeStatus =
  /** Only the latest version changed it: its value is taken unless the operator says otherwise. */
  | 'theirs'
  /** Only the draft changed it: the draft's value is kept. */
  | 'mine'
  /** Both changed it the same way. */
  | 'same'
  /** Both changed it, but different fields: the fields combine without a choice. Flags only. */
  | 'combined'
  /** Both changed it differently: the operator must choose. */
  | 'conflict';

export type FieldStatus = Exclude<MergeStatus, 'combined'>;

export interface FieldMergeEntry {
  readonly field: string;
  readonly status: FieldStatus;
  readonly base: unknown;
  readonly mine: unknown;
  readonly theirs: unknown;
}

export interface MergeEntry {
  readonly key: string;
  readonly status: MergeStatus;
  readonly base: Definition;
  readonly mine: Definition;
  readonly theirs: Definition;
  /**
   * Present when both sides changed a flag that both still have: the per-field merge, changed fields only.
   * The operator then chooses per field rather than for the whole flag.
   */
  readonly fields?: readonly FieldMergeEntry[];
}

/** JSON with object keys sorted, so key order alone never counts as a change. */
const canonical = (value: unknown): string =>
  value === undefined
    ? 'undefined'
    : JSON.stringify(value, (_key, inner: unknown) =>
        inner !== null && typeof inner === 'object' && !Array.isArray(inner)
          ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
          : inner,
      );

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

const statusOf = (base: unknown, mine: unknown, theirs: unknown): FieldStatus | undefined => {
  const mineChanged = !same(base, mine);
  const theirsChanged = !same(base, theirs);
  if (!mineChanged && !theirsChanged) return undefined;
  if (!mineChanged) return 'theirs';
  if (!theirsChanged) return 'mine';
  return same(mine, theirs) ? 'same' : 'conflict';
};

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const mergeFields = (base: Definition, mine: Fields, theirs: Fields): FieldMergeEntry[] => {
  const from: Fields = isFields(base) ? base : {};
  const names = [...new Set([...Object.keys(from), ...Object.keys(mine), ...Object.keys(theirs)])].sort();
  return names.flatMap((field): FieldMergeEntry[] => {
    const entry = { field, base: from[field], mine: mine[field], theirs: theirs[field] };
    const status = statusOf(entry.base, entry.mine, entry.theirs);
    return status === undefined ? [] : [{ ...entry, status }];
  });
};

/**
 * Three-way, per-feature merge of a draft (`mine`) and the latest snapshot (`theirs`) against the version
 * the draft started from (`base`). Features untouched on both sides are left out; the result is sorted by key.
 */
export function mergeFeatures(
  base: Readonly<Record<string, Definition>>,
  mine: Readonly<Record<string, Definition>>,
  theirs: Readonly<Record<string, Definition>>,
): MergeEntry[] {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])].sort();
  return keys.flatMap((key): MergeEntry[] => {
    const entry = { key, base: base[key], mine: mine[key], theirs: theirs[key] };
    const status = statusOf(entry.base, entry.mine, entry.theirs);
    // A type change reshapes the whole flag (a config default means nothing on a boolean), so mixing
    // fields across types could only produce nonsense: those stay a whole-flag choice.
    if (status !== 'conflict' || !isFields(entry.mine) || !isFields(entry.theirs) || !same(entry.mine.type, entry.theirs.type)) {
      return status === undefined ? [] : [{ ...entry, status }];
    }
    // Both sides still have the flag and changed it differently: go down to its fields.
    const fields = mergeFields(entry.base, entry.mine, entry.theirs);
    const combined = fields.every((field) => field.status !== 'conflict');
    return [{ ...entry, status: combined ? 'combined' : 'conflict', fields }];
  });
}

export type Side = 'mine' | 'theirs';

/** Per flag: one side for a whole-flag entry, or one side per field for a field-by-field entry. */
export type MergeChoices = Readonly<Record<string, Side | Readonly<Record<string, Side>>>>;

export type MergeResult =
  | { readonly ok: true; readonly features: Record<string, unknown> }
  /** Conflicts left without a choice, as `key` or `key.field`. */
  | { readonly ok: false; readonly missing: readonly string[] };

// Without an explicit choice, a one-sided change keeps the side that made it; a conflict has no default.
const defaultSide = (status: MergeStatus): Side | undefined =>
  status === 'theirs' ? 'theirs' : status === 'conflict' ? undefined : 'mine';

const withValue = (target: Readonly<Record<string, unknown>>, name: string, value: unknown): Record<string, unknown> =>
  value === undefined
    ? Object.fromEntries(Object.entries(target).filter(([key]) => key !== name))
    : { ...target, [name]: value };

/**
 * Applies the operator's choices to the draft's features. The draft is the starting point, so anything not
 * listed in `entries` stays exactly as the draft has it; a side without a flag or field removes it.
 */
export function applyMergeChoices(
  mine: Readonly<Record<string, unknown>>,
  entries: readonly MergeEntry[],
  choices: MergeChoices,
): MergeResult {
  const missing: string[] = [];
  let features: Record<string, unknown> = { ...mine };
  for (const entry of entries) {
    const choice = choices[entry.key];
    if (entry.fields === undefined) {
      const side = typeof choice === 'string' ? choice : defaultSide(entry.status);
      if (side === undefined) missing.push(entry.key);
      else features = withValue(features, entry.key, entry[side]);
      continue;
    }
    const fieldChoices = typeof choice === 'object' ? choice : {};
    // Field-by-field entries are only made when both sides have the flag as an object.
    let flag: Record<string, unknown> = { ...(entry.mine as Fields) };
    for (const field of entry.fields) {
      const side = fieldChoices[field.field] ?? defaultSide(field.status);
      if (side === undefined) missing.push(`${entry.key}.${field.field}`);
      else flag = withValue(flag, field.field, field[side]);
    }
    features = { ...features, [entry.key]: flag };
  }
  return missing.length === 0 ? { ok: true, features } : { ok: false, missing };
}
