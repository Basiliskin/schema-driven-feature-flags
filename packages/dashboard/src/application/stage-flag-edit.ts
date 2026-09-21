import { applyFlagEdit, type FlagEdit } from '../domain/flag-edit.js';
import type { PendingChangeSet } from '../domain/pending-change-set.js';
import type { BrowsePorts } from './browse-environment.js';
import { describeEdit, editFailure } from './edit-feature.js';
import { describeFailure } from './error-messages.js';
import type { WriteOutcome } from './publish-snapshot.js';

export type StagePorts = BrowsePorts;

export const NOTHING_TO_EDIT_MESSAGE =
  'This environment has no published snapshot version yet, so there is nothing to edit.';

export const STAGED_MESSAGE = 'Staged. Review your pending changes and choose Update to publish them.';

type StageFailure = Extract<WriteOutcome, { kind: 'failure' }>;

/**
 * Staging reports no version because nothing was published; every other field matches `WriteOutcome`,
 * so the notice and status-code helpers in http-server need no new case.
 */
export type StageOutcome =
  | { readonly kind: 'success'; readonly message: string; readonly pending: PendingChangeSet }
  | StageFailure;

const CREATED_BY = 'dashboard';

/** The snapshot the edit applies to, plus the Base Version the resulting draft keeps. */
const startingPoint = async (
  ports: StagePorts,
  environment: string,
  pending: PendingChangeSet | undefined,
): Promise<{ readonly text: string; readonly baseVersion: number } | StageFailure> => {
  if (pending !== undefined) {
    return { text: JSON.stringify(pending.snapshot), baseVersion: pending.baseVersion };
  }
  try {
    const baseVersion = await ports.readCurrentVersion(environment);
    if (baseVersion === undefined) {
      return { kind: 'failure', message: NOTHING_TO_EDIT_MESSAGE, issues: [] };
    }
    return { text: await ports.fetchSnapshotText(environment, baseVersion), baseVersion };
  } catch (error) {
    return { kind: 'failure', ...describeFailure(error) };
  }
};

/**
 * Folds one edit into the operator's accumulated draft and validates it immediately, so an invalid edit
 * is refused here rather than surfacing at publish time behind several good ones. Writes nothing.
 */
export async function stageFlagEdit(
  ports: StagePorts,
  environment: string,
  edit: FlagEdit,
  pending: PendingChangeSet | undefined,
): Promise<StageOutcome> {
  const start = await startingPoint(ports, environment, pending);
  if ('kind' in start) return start;

  const edited = applyFlagEdit(start.text, edit, { createdBy: CREATED_BY, reason: describeEdit(edit) });
  if (!edited.ok) return editFailure(edited.error);

  return {
    kind: 'success',
    message: STAGED_MESSAGE,
    pending: { baseVersion: start.baseVersion, snapshot: edited.value },
  };
}
