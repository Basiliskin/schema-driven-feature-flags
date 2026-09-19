import { segmentKeySchema } from '@featuresync/core';
import { z } from 'zod';
import { POINTER_SCHEMA_VERSION, environmentSchema, versionSchema, type PointerResult } from './current-pointer.js';
import { validateEnvironmentName, type PublishingError } from './publishing.js';

export interface SegmentPointer {
  readonly schemaVersion: typeof POINTER_SCHEMA_VERSION;
  readonly environment: string;
  readonly segmentKey: string;
  readonly version: number;
  readonly objectKey: string;
}

export type SegmentPointerResult =
  | { readonly ok: true; readonly value: SegmentPointer }
  | Extract<PointerResult, { readonly ok: false }>;

export interface InvalidSegmentKey {
  readonly reason: 'INVALID_SEGMENT_KEY';
  readonly message: string;
}

export type SegmentKeyResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: InvalidSegmentKey };

export const segmentObjectKeyFor = (environment: string, segmentKey: string, version: number): string =>
  `${environment}/segments/${segmentKey}/${String(version)}.json`;

export const segmentPointerKeyFor = (environment: string, segmentKey: string): string =>
  `${environment}/segments/${segmentKey}/current.json`;

const segmentPointerSchema = z
  .object({
    schemaVersion: z.literal(POINTER_SCHEMA_VERSION),
    environment: environmentSchema,
    segmentKey: segmentKeySchema,
    version: versionSchema,
    objectKey: z.string(),
  })
  .refine(
    (pointer) => pointer.objectKey === segmentObjectKeyFor(pointer.environment, pointer.segmentKey, pointer.version),
    {
      path: ['objectKey'],
      message: 'objectKey must equal <environment>/segments/<segmentKey>/<version>.json',
    },
  );

export function parseSegmentPointer(raw: unknown): SegmentPointerResult {
  const parsed = segmentPointerSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: Object.freeze(parsed.data) };
  return {
    ok: false,
    error: {
      reason: 'INVALID_POINTER',
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    },
  };
}

export const nextSegmentVersion = (current: SegmentPointer | undefined): number =>
  current === undefined ? 1 : current.version + 1;

export type BuildSegmentPointerResult =
  | { readonly ok: true; readonly value: SegmentPointer }
  | { readonly ok: false; readonly error: PublishingError | InvalidSegmentKey };

export function buildSegmentPointer(environment: string, segmentKey: string, version: number): BuildSegmentPointerResult {
  const validEnvironment = validateEnvironmentName(environment);
  if (!validEnvironment.ok) return validEnvironment;
  const validKey = validateSegmentKey(segmentKey);
  if (!validKey.ok) return validKey;
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: POINTER_SCHEMA_VERSION,
      environment,
      segmentKey,
      version,
      objectKey: segmentObjectKeyFor(environment, segmentKey, version),
    }),
  };
}

export function validateSegmentKey(input: string): SegmentKeyResult {
  const parsed = segmentKeySchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: { reason: 'INVALID_SEGMENT_KEY', message: parsed.error.issues.map((issue) => issue.message).join('; ') },
  };
}
