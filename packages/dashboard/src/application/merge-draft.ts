import { applyMergeChoices, mergeFeatures, type MergeChoices, type MergeEntry } from '../domain/snapshot-merge.js';
import type { BrowsePorts } from './browse-environment.js';

export type DraftMerge =
  | { readonly status: 'invalid-draft' }
  /** The base or latest snapshot is missing or not JSON with a `features` object. */
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly from: number; readonly to: number; readonly entries: readonly MergeEntry[] };

const featuresOf = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const { features } = value as { features?: unknown };
  return features !== null && typeof features === 'object' && !Array.isArray(features)
    ? (features as Record<string, unknown>)
    : undefined;
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const readFeatures = async (ports: BrowsePorts, environment: string, version: number) => {
  try {
    return featuresOf(parse(await ports.fetchSnapshotText(environment, version)));
  } catch {
    return undefined;
  }
};

/**
 * Lines a pasted snapshot draft up against what was published since it was started, feature by feature,
 * so the operator can choose what to carry into it. Works on raw JSON so a half-finished draft still merges.
 */
export async function mergeDraft(
  ports: BrowsePorts,
  environment: string,
  since: number,
  draftText: string,
): Promise<DraftMerge> {
  const mine = featuresOf(parse(draftText));
  if (mine === undefined) return { status: 'invalid-draft' };
  const current = await ports.readCurrentVersion(environment);
  if (current === undefined) return { status: 'unavailable' };
  const [base, theirs] = await Promise.all([
    readFeatures(ports, environment, since),
    readFeatures(ports, environment, current),
  ]);
  if (base === undefined || theirs === undefined) return { status: 'unavailable' };
  return { status: 'ready', from: since, to: current, entries: mergeFeatures(base, mine, theirs) };
}

export type AppliedMerge =
  | Exclude<DraftMerge, { status: 'ready' }>
  /** The latest version is no longer the one the operator reviewed, so the choices may not fit it. */
  | { readonly status: 'moved'; readonly to: number }
  | { readonly status: 'missing'; readonly missing: readonly string[] }
  | { readonly status: 'merged'; readonly snapshotText: string; readonly to: number };

/**
 * Recomputes the merge the operator reviewed and applies their choices to the draft. Only `features`
 * changes; everything else in the draft (reason, metadata) stays as they wrote it.
 */
export async function applyDraftMerge(
  ports: BrowsePorts,
  environment: string,
  since: number,
  reviewedVersion: number,
  draftText: string,
  choices: MergeChoices,
): Promise<AppliedMerge> {
  const merge = await mergeDraft(ports, environment, since, draftText);
  if (merge.status !== 'ready') return merge;
  if (merge.to !== reviewedVersion) return { status: 'moved', to: merge.to };
  // A ready merge means the draft parsed as JSON with a features object.
  const draft = parse(draftText) as { features: Record<string, unknown> };
  const result = applyMergeChoices(draft.features, merge.entries, choices);
  if (!result.ok) return { status: 'missing', missing: result.missing };
  return { status: 'merged', to: merge.to, snapshotText: JSON.stringify({ ...draft, features: result.features }, null, 2) };
}
