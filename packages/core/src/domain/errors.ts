export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class SnapshotValidationError extends Error {
  override readonly name = 'SnapshotValidationError';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`Invalid snapshot:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`);
  }
}

export class FeatureDefinitionError extends Error {
  override readonly name = 'FeatureDefinitionError';

  constructor(
    readonly featureKey: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(
      `Invalid default for feature "${featureKey}":\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`,
    );
  }
}

export const formatPath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((formatted, segment) => {
    if (typeof segment === 'number') return `${formatted}[${String(segment)}]`;
    const name = String(segment);
    return formatted === '' ? name : `${formatted}.${name}`;
  }, '');

export const toIssues = (
  zodIssues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  prefix: readonly PropertyKey[] = [],
): ValidationIssue[] =>
  zodIssues.map((issue) => ({ path: formatPath([...prefix, ...issue.path]) || '(root)', message: issue.message }));
