import type { Condition } from '@featuresync/core';
import { viewSnapshotVersion, type BrowsePorts, type FlagDefinitionView } from './browse-environment.js';

/** One segment the Environment's `segments/` prefix actually holds, as its Segment Pointer describes it. */
export interface PublishedSegment {
  readonly segmentKey: string;
  readonly version: number;
  /** Absent on a segment published before the Member Attribute was stored on the pointer. */
  readonly memberAttribute?: string | undefined;
}

export type PublishedSegmentListing =
  | { readonly status: 'listed'; readonly segments: readonly PublishedSegment[] }
  | { readonly status: 'unavailable' };

export interface PublishedSegmentsPort {
  /** Resolves to `unavailable` rather than rejecting when the listing itself cannot be read. */
  listPublishedSegments(environment: string): Promise<PublishedSegmentListing>;
}

export type ListPublishedSegmentsPorts = BrowsePorts & PublishedSegmentsPort;

export type SegmentAttribute =
  | { readonly status: 'known'; readonly memberAttribute: string }
  | { readonly status: 'unknown' };

export type SegmentUsage =
  | { readonly status: 'used'; readonly flagKeys: readonly string[] }
  | { readonly status: 'unused' };

export interface PublishedSegmentRow {
  readonly segmentKey: string;
  readonly version: number;
  readonly attribute: SegmentAttribute;
  readonly usage: SegmentUsage;
}

export type PublishedSegmentsView =
  | { readonly status: 'listed'; readonly rows: readonly PublishedSegmentRow[] }
  | { readonly status: 'unavailable' };

// Rules reach this layer as `unknown` but have been through parseSnapshot, so they hold a validated Condition.
const conditionOf = (rule: unknown): Condition => (rule as { readonly when: Condition }).when;

const segmentKeysOf = (flag: FlagDefinitionView): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const rule of flag.rules) {
    for (const expected of Object.values(conditionOf(rule))) {
      if (typeof expected === 'object' && expected.inSegment !== undefined) keys.add(expected.inSegment);
    }
  }
  return keys;
};

const flagKeysBySegment = (flags: readonly FlagDefinitionView[]): ReadonlyMap<string, readonly string[]> => {
  const usage = new Map<string, string[]>();
  for (const flag of [...flags].sort((left, right) => left.key.localeCompare(right.key))) {
    for (const segmentKey of segmentKeysOf(flag)) {
      const users = usage.get(segmentKey);
      if (users === undefined) usage.set(segmentKey, [flag.key]);
      else users.push(flag.key);
    }
  }
  return usage;
};

const currentFlags = async (
  ports: ListPublishedSegmentsPorts,
  environment: string,
): Promise<readonly FlagDefinitionView[]> => {
  const currentVersion = await ports.readCurrentVersion(environment);
  if (currentVersion === undefined) return [];
  const current = await viewSnapshotVersion(ports, environment, currentVersion);
  if (current.status === 'not-available' || current.contents.status === 'invalid') return [];
  return current.contents.flags;
};

const toRow = (segment: PublishedSegment, flagKeys: readonly string[] | undefined): PublishedSegmentRow => ({
  segmentKey: segment.segmentKey,
  version: segment.version,
  attribute:
    segment.memberAttribute === undefined
      ? { status: 'unknown' }
      : { status: 'known', memberAttribute: segment.memberAttribute },
  usage: flagKeys === undefined ? { status: 'unused' } : { status: 'used', flagKeys },
});

/**
 * Lists every segment published in the Environment — the population comes from the Segment Catalog listing,
 * never from the keys the current Snapshot's rules happen to mention, so an unattached segment is still shown.
 */
export async function listPublishedSegments(
  ports: ListPublishedSegmentsPorts,
  environment: string,
): Promise<PublishedSegmentsView> {
  const listing = await ports.listPublishedSegments(environment);
  if (listing.status === 'unavailable') return { status: 'unavailable' };

  const usage = flagKeysBySegment(await currentFlags(ports, environment));
  const rows = [...listing.segments]
    .sort((left, right) => left.segmentKey.localeCompare(right.segmentKey))
    .map((segment) => toRow(segment, usage.get(segment.segmentKey)));
  return { status: 'listed', rows };
}
