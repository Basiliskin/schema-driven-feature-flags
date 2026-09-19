import { parseSnapshot, type ValidationIssue } from '@featuresync/core';

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
}

export type SnapshotContents =
  | { readonly status: 'valid'; readonly flags: readonly FlagDefinitionView[] }
  | { readonly status: 'invalid'; readonly issues: readonly ValidationIssue[] };

export type SnapshotVersionView =
  | { readonly environment: string; readonly version: number; readonly status: 'not-available' }
  | {
      readonly environment: string;
      readonly version: number;
      readonly status: 'available';
      readonly contents: SnapshotContents;
    };

export type EnvironmentView =
  | { readonly environment: string; readonly status: 'empty' }
  | {
      readonly environment: string;
      readonly status: 'published';
      readonly currentVersion: number;
      readonly versions: readonly number[];
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
  return {
    status: 'valid',
    flags: Object.entries(parsed.value.features).map(([key, feature]) => ({
      key,
      type: feature.type,
      enabled: feature.enabled,
      defaultValue: feature.type === 'config' ? feature.default : feature.enabled,
      ruleCount: feature.rules.length,
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

export async function browseEnvironment(ports: BrowsePorts, environment: string): Promise<EnvironmentView> {
  const currentVersion = await ports.readCurrentVersion(environment);
  if (currentVersion === undefined) return { environment, status: 'empty' };
  return {
    environment,
    status: 'published',
    currentVersion,
    versions: Array.from({ length: currentVersion }, (_, index) => index + 1),
    current: await viewSnapshotVersion(ports, environment, currentVersion),
  };
}
