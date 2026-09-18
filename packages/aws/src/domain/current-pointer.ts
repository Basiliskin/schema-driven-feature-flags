import { z } from 'zod';

export const POINTER_SCHEMA_VERSION = 1;

export interface CurrentPointer {
  readonly schemaVersion: typeof POINTER_SCHEMA_VERSION;
  readonly environment: string;
  readonly version: number;
  readonly snapshotKey: string;
}

export interface PointerIssue {
  readonly path: string;
  readonly message: string;
}

export interface InvalidPointer {
  readonly reason: 'INVALID_POINTER';
  readonly issues: readonly PointerIssue[];
}

export type PointerResult =
  | { readonly ok: true; readonly value: CurrentPointer }
  | { readonly ok: false; readonly error: InvalidPointer };

export const snapshotKeyFor = (environment: string, version: number): string =>
  `${environment}/snapshots/${String(version)}.json`;

const pointerSchema = z
  .object({
    schemaVersion: z.literal(POINTER_SCHEMA_VERSION),
    environment: z.string().min(1).regex(/^[^/]+$/, 'environment must not contain "/"'),
    version: z.int().positive(),
    snapshotKey: z.string(),
  })
  .refine((pointer) => pointer.snapshotKey === snapshotKeyFor(pointer.environment, pointer.version), {
    path: ['snapshotKey'],
    message: 'snapshotKey must equal <environment>/snapshots/<version>.json',
  });

export function parseCurrentPointer(raw: unknown): PointerResult {
  const parsed = pointerSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: Object.freeze(parsed.data) };
  return {
    ok: false,
    error: {
      reason: 'INVALID_POINTER',
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    },
  };
}
