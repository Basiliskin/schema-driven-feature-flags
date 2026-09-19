import type { S3FetchErrorReason, S3PublishErrorReason } from '@featuresync/aws';

export const PUBLISH_ERROR_MESSAGES: Record<S3PublishErrorReason, string> = {
  INVALID_ENVIRONMENT: 'Invalid environment name.',
  INVALID_POINTER: 'The environment’s current.json is malformed; repair it by hand before publishing or rolling back.',
  INVALID_SNAPSHOT: 'The snapshot is not valid.',
  ENVIRONMENT_MISMATCH: 'The snapshot names a different environment; set its "environment" to this one before publishing.',
  VERSION_EXISTS: 'Someone else published at the same moment and took the next version number. Reload the page and retry.',
  CONFLICT: 'Another writer moved the current pointer while this change was in progress. Reload the page and retry.',
  INVALID_ROLLBACK_TARGET: 'That version cannot be rolled back to; pick an existing version other than the current one.',
  VERSION_PROBE_LIMIT:
    'No free version number was found after the current one; the snapshots folder needs attention before publishing.',
  REQUEST_FAILED: 'The S3 request failed; check connectivity and credentials, then retry.',
};

export const FETCH_ERROR_MESSAGES: Record<S3FetchErrorReason, string> = {
  INVALID_ENVIRONMENT: 'Invalid environment name.',
  INVALID_VERSION: 'The version must be a positive integer.',
  SNAPSHOT_NOT_FOUND: 'That snapshot version is not available in this environment.',
  ACCESS_DENIED: 'Access denied; check the credentials and their s3:GetObject permission.',
  EMPTY_SNAPSHOT: 'The snapshot file is empty.',
  REQUEST_FAILED: 'The S3 read failed; check connectivity and credentials, then retry.',
};

export const NOTIFY_FAILED_WARNING =
  'The change is live, but its change notification could not be sent; subscribers will pick it up on their next poll.';

export const INVALID_JSON_MESSAGE = 'The pasted text is not valid JSON.';

export const UNEXPECTED_ERROR_MESSAGE = 'The request failed unexpectedly; see the dashboard’s terminal output.';

export interface FailureDescription {
  readonly message: string;
  readonly issues: readonly string[];
}

// Matched structurally so this layer never loads the aws runtime just for an instanceof check.
const reasonOf = <R extends string>(error: unknown, name: string, messages: Record<R, string>): R | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name: errorName, reason } = error as { name?: unknown; reason?: unknown };
  return errorName === name && typeof reason === 'string' && Object.hasOwn(messages, reason) ? (reason as R) : undefined;
};

const issueLines = (cause: unknown): readonly string[] => {
  const issues = (cause as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue: { path?: unknown; message?: unknown }) => `${String(issue.path)}: ${String(issue.message)}`);
};

export function describeFailure(error: unknown): FailureDescription {
  const publishReason = reasonOf(error, 'S3PublishError', PUBLISH_ERROR_MESSAGES);
  if (publishReason !== undefined) {
    const issues =
      publishReason === 'INVALID_SNAPSHOT' || publishReason === 'INVALID_POINTER'
        ? issueLines((error as Error).cause)
        : [];
    return { message: PUBLISH_ERROR_MESSAGES[publishReason], issues };
  }
  const fetchReason = reasonOf(error, 'S3FetchError', FETCH_ERROR_MESSAGES);
  if (fetchReason !== undefined) return { message: FETCH_ERROR_MESSAGES[fetchReason], issues: [] };
  return { message: UNEXPECTED_ERROR_MESSAGE, issues: [] };
}

export const EDIT_CONFLICT = (currentVersion?: number): string =>
  currentVersion === undefined
    ? 'Someone else published a new version meanwhile — reload and redo your edit.'
    : `Someone else published version ${String(currentVersion)} meanwhile — reload and redo your edit.`;

export const UNKNOWN_FEATURE_MESSAGE = (key: string): string => `The snapshot has no feature named "${key}".`;

export const DEFAULT_NOT_EDITABLE_MESSAGE = (key: string): string =>
  `"${key}" is a boolean feature; only config features have an editable default.`;

export const INVALID_DEFAULT_JSON_MESSAGE = 'The default value is not valid JSON.';

export const EDITED_SNAPSHOT_INVALID_MESSAGE = 'The edited snapshot is not valid.';

export const INVALID_RULES_JSON_MESSAGE = 'The rules are not valid JSON.';

export const FEATURE_EXISTS_MESSAGE = (key: string): string =>
  `A feature named "${key}" already exists; pick another key or edit the existing feature.`;

export const INVALID_KEY_MESSAGE = (key: string): string =>
  `"${key}" is not a valid feature key; use letters, digits, ".", "_" or "-", starting with a letter or digit.`;
