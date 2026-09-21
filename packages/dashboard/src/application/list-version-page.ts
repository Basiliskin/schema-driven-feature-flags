import { viewSnapshotVersion, toVersionEntry, type BrowsePorts, type VersionEntry } from './browse-environment.js';

/** Upper bound on how many Snapshot Versions one history page may read, so an untrusted pageSize cannot restore the full fan-out. */
export const MAX_VERSION_PAGE_SIZE = 50;
export const DEFAULT_VERSION_PAGE_SIZE = 20;

export interface VersionPage {
  readonly environment: string;
  readonly page: number;
  readonly pageSize: number;
  readonly totalVersions: number;
  /** Newest first. Empty when the Environment has no published version or the page is past the end. */
  readonly entries: readonly VersionEntry[];
  readonly hasNewer: boolean;
  readonly hasOlder: boolean;
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), min), max) : fallback;

export async function listVersionPage(
  ports: BrowsePorts,
  environment: string,
  page: number,
  pageSize: number,
): Promise<VersionPage> {
  const requestedPage = clamp(page, 1, Number.MAX_SAFE_INTEGER, 1);
  const size = clamp(pageSize, 1, MAX_VERSION_PAGE_SIZE, DEFAULT_VERSION_PAGE_SIZE);
  const totalVersions = (await ports.readCurrentVersion(environment)) ?? 0;

  // History is linear (1..total), so the page's version numbers are arithmetic; no listing or index is needed.
  const newest = totalVersions - (requestedPage - 1) * size;
  const oldest = Math.max(newest - size + 1, 1);
  const numbers = newest < 1 ? [] : Array.from({ length: newest - oldest + 1 }, (_entry, index) => newest - index);
  const views = await Promise.all(numbers.map((version) => viewSnapshotVersion(ports, environment, version)));

  return {
    environment,
    page: requestedPage,
    pageSize: size,
    totalVersions,
    entries: views.map(toVersionEntry),
    hasNewer: requestedPage > 1,
    hasOlder: numbers.length > 0 && oldest > 1,
  };
}
