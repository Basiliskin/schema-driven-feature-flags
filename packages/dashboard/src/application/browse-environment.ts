import { parseSnapshot, referencedSegmentKeys, type ValidationIssue } from '@featuresync/core';

/** How many of the newest Snapshot Versions the Environment view loads, so its cost stays flat as history grows. */
export const ENVIRONMENT_VERSION_WINDOW = 5;

export interface BrowsePorts {
  /** Resolves to `undefined` when the Environment has no published Snapshot Version yet. */
  readCurrentVersion(environment: string): Promise<number | undefined>;
  fetchSnapshotText(environment: string, version: number): Promise<string>;
}

export interface FlagDefinitionView {
  readonly key: string;
  readonly type: 'boolean' | 'config';
  readonly enabled: boolean;
  readonly defaultValue: unknown;
  readonly ruleCount: number;
  readonly rules: readonly unknown[];
}

/** Who published a Snapshot Version, when and why. */
export interface SnapshotMetadata {
  readonly createdAt: string;
  readonly createdBy: string;
  readonly reason: string;
}

export type SnapshotContents =
  | {
      readonly status: 'valid';
      readonly flags: readonly FlagDefinitionView[];
      readonly metadata: SnapshotMetadata;
      /** Every Segment Key the rules reference, sorted; empty when none do. */
      readonly segmentKeys: readonly string[];
      /** The stored body as parsed JSON, key order kept. */
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | { readonly status: 'invalid'; readonly issues: readonly ValidationIssue[] };

export type SnapshotVersionView =
  | { readonly environment: string; readonly version: number; readonly status: 'not-available' }
  | {
      readonly environment: string;
      readonly version: number;
      readonly status: 'available';
      readonly contents: SnapshotContents;
    };

export interface VersionEntry {
  readonly version: number;
  /** Absent when that version's snapshot file is missing or not valid. */
  readonly metadata?: SnapshotMetadata;
}

export type EnvironmentView =
  | { readonly environment: string; readonly status: 'empty' }
  | {
      readonly environment: string;
      readonly status: 'published';
      readonly currentVersion: number;
      readonly versions: readonly VersionEntry[];
      readonly current: SnapshotVersionView;
    };

// Matched structurally so this layer never loads the aws runtime just for an instanceof check.
const isSnapshotNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'reason' in error && error.reason === 'SNAPSHOT_NOT_FOUND';

const readContents = (text: string): SnapshotContents => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { status: 'invalid', issues: [{ path: '', message: (error as Error).message }] };
  }
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) return { status: 'invalid', issues: parsed.error.issues };
  const { createdAt, createdBy, reason } = parsed.value;
  return {
    status: 'valid',
    metadata: { createdAt, createdBy, reason },
    segmentKeys: [...referencedSegmentKeys(parsed.value)].sort(),
    raw: raw as Record<string, unknown>,
    flags: Object.entries(parsed.value.features).map(([key, feature]) => ({
      key,
      type: feature.type,
      enabled: feature.enabled,
      defaultValue: feature.type === 'config' ? feature.default : feature.enabled,
      ruleCount: feature.rules.length,
      rules: feature.rules,
    })),
  };
};

export async function viewSnapshotVersion(
  ports: BrowsePorts,
  environment: string,
  version: number,
): Promise<SnapshotVersionView> {
  let text: string;
  try {
    text = await ports.fetchSnapshotText(environment, version);
  } catch (error) {
    if (isSnapshotNotFound(error)) return { environment, version, status: 'not-available' };
    throw error;
  }
  return { environment, version, status: 'available', contents: readContents(text) };
}

export const toVersionEntry = (view: SnapshotVersionView): VersionEntry =>
  view.status === 'available' && view.contents.status === 'valid'
    ? { version: view.version, metadata: view.contents.metadata }
    : { version: view.version };

export async function browseEnvironment(ports: BrowsePorts, environment: string): Promise<EnvironmentView> {
  const currentVersion = await ports.readCurrentVersion(environment);
  if (currentVersion === undefined) return { environment, status: 'empty' };
  // History is linear (1..current), so the newest window is read by key; no bucket listing is needed.
  const windowSize = Math.min(currentVersion, ENVIRONMENT_VERSION_WINDOW);
  const oldest = currentVersion - windowSize + 1;
  const views = await Promise.all(
    Array.from({ length: windowSize }, (_, index) => viewSnapshotVersion(ports, environment, oldest + index)),
  );
  return {
    environment,
    status: 'published',
    currentVersion,
    versions: views.map(toVersionEntry),
    current: views.find((view) => view.version === currentVersion) as SnapshotVersionView,
  };
}
