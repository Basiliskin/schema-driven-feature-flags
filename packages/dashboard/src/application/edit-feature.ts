import { applyFlagEdit, canReplayEdit, type FlagEdit, type FlagEditFailure, type FlagEditMeta } from '../domain/flag-edit.js';
import type { BrowsePorts } from './browse-environment.js';
import {
  DEFAULT_NOT_EDITABLE_MESSAGE,
  EDIT_REPLAYED,
  describeFailure,
  EDITED_SNAPSHOT_INVALID_MESSAGE,
  FEATURE_EXISTS_MESSAGE,
  INVALID_DEFAULT_JSON_MESSAGE,
  INVALID_KEY_MESSAGE,
  INVALID_PERCENTAGE_MESSAGE,
  INVALID_RULE_INDEX_MESSAGE,
  INVALID_RULES_JSON_MESSAGE,
  INVALID_SEGMENT_KEY_MESSAGE,
  SEGMENT_NEEDS_SCHEMA_VERSION_2_MESSAGE,
  UNKNOWN_FEATURE_MESSAGE,
} from './error-messages.js';
import { publishExpecting, type WriteOutcome, type WritePorts } from './publish-snapshot.js';

export type EditFeaturePorts = BrowsePorts & WritePorts;

const CREATED_BY = 'dashboard';

const describeEdit = (edit: FlagEdit): string => {
  switch (edit.kind) {
    case 'enabled':
      return `Set ${edit.key}.enabled=${String(edit.enabled)} via dashboard`;
    case 'default':
      return `Set ${edit.key}.default via dashboard`;
    case 'create':
      return `Create ${edit.type} feature ${edit.key} via dashboard`;
    case 'delete':
      return `Delete feature ${edit.key} via dashboard`;
    case 'setRules':
      return `Set ${edit.key}.rules via dashboard`;
    case 'setRollout':
      return `Set ${edit.key} rule ${String(edit.ruleIndex)} rollout to ${String(edit.percentage)}% via dashboard`;
    case 'removeRollout':
      return `Remove ${edit.key} rule ${String(edit.ruleIndex)} rollout via dashboard`;
    case 'attachSegment':
      return `Attach segment ${edit.segmentKey} to ${edit.key} via dashboard`;
    case 'detachSegment':
      return `Detach ${edit.key} rule ${String(edit.ruleIndex)} via dashboard`;
  }
};

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
    case 'INVALID_RULES_JSON':
      return {
        kind: 'failure',
        message: INVALID_RULES_JSON_MESSAGE,
        issues: [failure.message],
      };
    case 'FEATURE_EXISTS':
      return {
        kind: 'failure',
        message: FEATURE_EXISTS_MESSAGE(failure.key),
        issues: [],
      };
    case 'INVALID_KEY':
      return {
        kind: 'failure',
        message: INVALID_KEY_MESSAGE(failure.key),
        issues: [],
      };
    case 'INVALID_RULE_INDEX':
      return {
        kind: 'failure',
        message: INVALID_RULE_INDEX_MESSAGE(failure.key, failure.ruleIndex),
        issues: [],
        invalidInput: true,
      };
    case 'INVALID_PERCENTAGE':
      return {
        kind: 'failure',
        message: INVALID_PERCENTAGE_MESSAGE,
        issues: [],
        invalidInput: true,
      };
    case 'INVALID_SEGMENT_KEY':
      return {
        kind: 'failure',
        message: INVALID_SEGMENT_KEY_MESSAGE(failure.segmentKey),
        issues: [],
        invalidInput: true,
      };
    case 'SEGMENT_NEEDS_SCHEMA_VERSION_2':
      return {
        kind: 'failure',
        message: SEGMENT_NEEDS_SCHEMA_VERSION_2_MESSAGE(failure.key),
        issues: [],
      };
    case 'INVALID_SNAPSHOT':
      return {
        kind: 'failure',
        message: EDITED_SNAPSHOT_INVALID_MESSAGE,
        issues: failure.issues,
      };
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

  const meta = { createdBy: CREATED_BY, reason: describeEdit(edit) };
  const edited = applyFlagEdit(text, edit, meta);
  if (!edited.ok) return editFailure(edited.error);

  const outcome = await publishExpecting(ports, environment, edited.value, baseVersion);
  if (outcome.kind === 'success' || outcome.conflict === undefined) return outcome;
  return (await replayOnLatest(ports, environment, text, edit, meta, baseVersion)) ?? outcome;
}

const readLatest = async (ports: EditFeaturePorts, environment: string) => {
  try {
    const version = await ports.readCurrentVersion(environment);
    return version === undefined ? undefined : { version, text: await ports.fetchSnapshotText(environment, version) };
  } catch {
    return undefined;
  }
};

/**
 * Someone published while the operator was editing. When nothing this edit touches changed in between,
 * the edit is re-applied to the latest version and published once more, so it goes through as if made there.
 * Resolves to `undefined` when that isn't safe, leaving the conflict for the operator to review.
 */
async function replayOnLatest(
  ports: EditFeaturePorts,
  environment: string,
  baseText: string,
  edit: FlagEdit,
  meta: FlagEditMeta,
  baseVersion: number,
): Promise<WriteOutcome | undefined> {
  const latest = await readLatest(ports, environment);
  if (latest === undefined || !canReplayEdit(baseText, latest.text, edit)) return undefined;
  const replayed = applyFlagEdit(latest.text, edit, meta);
  if (!replayed.ok) return editFailure(replayed.error);
  const outcome = await publishExpecting(ports, environment, replayed.value, latest.version);
  if (outcome.kind === 'success') {
    return { ...outcome, message: `${outcome.message} ${EDIT_REPLAYED(latest.version)}` };
  }
  // Lost the race a second time: report against the version the operator actually edited.
  return outcome.conflict === undefined ? outcome : { ...outcome, conflict: { since: baseVersion } };
}
