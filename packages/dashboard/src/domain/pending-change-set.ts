/**
 * The dashboard is a stateless local server, so an operator's unpublished edits travel back and
 * forth inside the page itself — one hidden form field on every rendered form. This module owns
 * what that field holds and how it survives the round trip.
 */

export type PendingSnapshot = Record<string, unknown>;

export interface PendingChangeSet {
  /** The snapshot version the draft started from, kept frozen so Version Drift stays detectable. */
  readonly baseVersion: number;
  /** Every staged edit already applied, in the shape `applyFlagEdit` returns. */
  readonly snapshot: PendingSnapshot;
}

/**
 * Well under the 1 MiB `MAX_BODY_BYTES` cap `readForm` enforces on the flag-edit route, so an
 * accumulated draft is refused here with a clean "no pending changes" rather than reaching the 413
 * path, which would lose the request outright.
 */
export const MAX_PENDING_CHANGE_SET_BYTES = 256 * 1024;

const VERSION_PATTERN = /^[1-9]\d{0,8}$/;

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

const isPendingSnapshot = (value: unknown): value is PendingSnapshot =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBaseVersion = (value: unknown): value is number =>
  typeof value === 'number' && VERSION_PATTERN.test(String(value));

/** URI-encoded so the result carries no quote or newline that would break an HTML value attribute. */
export const serializePendingChangeSet = (set: PendingChangeSet): string =>
  encodeURIComponent(JSON.stringify({ baseVersion: set.baseVersion, snapshot: set.snapshot }));

/**
 * The field is as client-supplied as the query string, so anything that is not a well-formed change
 * set reads as "no pending changes" instead of throwing — the same fallback discipline
 * `parseUrlStateFields` uses, so a hand-edited field cannot turn into a 400 error page and take the
 * operator's draft with it.
 */
export const parsePendingChangeSet = (raw: string | undefined | null): PendingChangeSet | undefined => {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (byteLength(raw) > MAX_PENDING_CHANGE_SET_BYTES) return undefined;
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(raw));
    if (!isPendingSnapshot(decoded)) return undefined;
    const { baseVersion, snapshot } = decoded;
    if (!isBaseVersion(baseVersion) || !isPendingSnapshot(snapshot)) return undefined;
    return { baseVersion, snapshot };
  } catch {
    return undefined;
  }
};
