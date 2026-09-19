import { applyFlagEdit, type FlagEdit, type FlagEditFailure } from '../domain/flag-edit.js';
import type { BrowsePorts } from './browse-environment.js';
import {
  DEFAULT_NOT_EDITABLE_MESSAGE,
  describeFailure,
  EDIT_AFTER_ROLLBACK,
  EDIT_CONFLICT,
  EDITED_SNAPSHOT_INVALID_MESSAGE,
  INVALID_DEFAULT_JSON_MESSAGE,
  UNKNOWN_FEATURE_MESSAGE,
} from './error-messages.js';
import { write, type WriteOutcome, type WritePorts } from './publish-snapshot.js';

export type EditFeaturePorts = BrowsePorts & WritePorts & { readonly now: () => Date };

const CREATED_BY = 'dashboard';

const describeEdit = (edit: FlagEdit): string =>
  edit.kind === 'enabled'
    ? `Set ${edit.key}.enabled=${String(edit.enabled)} via dashboard`
    : `Set ${edit.key}.default via dashboard`;

const editFailure = (failure: FlagEditFailure): WriteOutcome => {
  switch (failure.kind) {
    case 'UNKNOWN_FEATURE':
      return {
        kind: 'failure',
        message: UNKNOWN_FEATURE_MESSAGE(failure.key),
        issues: [],
      };
    case 'DEFAULT_NOT_EDITABLE':
      return {
        kind: 'failure',
        message: DEFAULT_NOT_EDITABLE_MESSAGE(failure.key),
        issues: [],
      };
    case 'INVALID_DEFAULT_JSON':
      return {
        kind: 'failure',
        message: INVALID_DEFAULT_JSON_MESSAGE,
        issues: [failure.message],
      };
    case 'INVALID_SNAPSHOT':
      return {
        kind: 'failure',
        message: EDITED_SNAPSHOT_INVALID_MESSAGE,
        issues: failure.issues,
      };
  }
};

// Matched structurally so this layer never loads the aws runtime just for an instanceof check.
const publishReasonOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'S3PublishError'
    ? (error as { reason?: unknown }).reason
    : undefined;

const readPointerAfterFailure = async (ports: BrowsePorts, environment: string): Promise<number | undefined> => {
  try {
    return await ports.readCurrentVersion(environment);
  } catch {
    return undefined;
  }
};

export async function editFeature(
  ports: EditFeaturePorts,
  environment: string,
  baseVersion: number,
  edit: FlagEdit,
): Promise<WriteOutcome> {
  let text: string;
  try {
    text = await ports.fetchSnapshotText(environment, baseVersion);
  } catch (error) {
    return { kind: 'failure', ...describeFailure(error) };
  }

  const edited = applyFlagEdit(text, edit, {
    baseVersion,
    createdBy: CREATED_BY,
    reason: describeEdit(edit),
    now: ports.now(),
  });
  if (!edited.ok) return editFailure(edited.error);

  let publishReason: unknown;
  const outcome = await write(
    ports,
    async (writer) => {
      try {
        return await writer.publish(environment, edited.value, {
          expectedCurrentVersion: baseVersion,
        });
      } catch (error) {
        publishReason = publishReasonOf(error);
        throw error;
      }
    },
    (version) => `Published version ${String(version)} to ${environment}.`,
  );
  if (outcome.kind === 'success' || (publishReason !== 'CONFLICT' && publishReason !== 'VERSION_EXISTS')) {
    return outcome;
  }

  const current = await readPointerAfterFailure(ports, environment);
  const message =
    publishReason === 'VERSION_EXISTS' && current === baseVersion
      ? EDIT_AFTER_ROLLBACK(baseVersion + 1)
      : EDIT_CONFLICT(current);
  return { kind: 'failure', message, issues: [] };
}
