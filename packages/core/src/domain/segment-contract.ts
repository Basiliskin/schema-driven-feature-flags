import { z } from 'zod';
import { err, ok, toIssues, type Result, type ValidationIssue } from './errors.js';

export const SEGMENT_SCHEMA_VERSION = 1;
export const MAX_SEGMENT_MEMBERS = 100_000;
export const MAX_SEGMENT_MEMBER_LENGTH = 256;

export const SEGMENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const segmentKeySchema = z
  .string()
  .regex(SEGMENT_KEY_PATTERN, 'Segment keys are 1-64 letters, digits, "-" or "_", starting with a letter or digit');

// Messages name positions only: members are personal data and must never reach an error or a log.
const memberSchema = z
  .string({ error: 'Members must be strings' })
  .min(1, 'Members must not be empty')
  .max(MAX_SEGMENT_MEMBER_LENGTH, `Members must be at most ${String(MAX_SEGMENT_MEMBER_LENGTH)} characters`);

export const segmentContract = z.object({
  schemaVersion: z.literal(SEGMENT_SCHEMA_VERSION),
  key: segmentKeySchema,
  version: z.int().positive(),
  memberAttribute: z.string().min(1),
  members: z
    .array(memberSchema)
    .max(MAX_SEGMENT_MEMBERS, `A segment holds at most ${String(MAX_SEGMENT_MEMBERS)} members`)
    .superRefine((members, context) => {
      const seen = new Set<string>();
      members.forEach((member, index) => {
        if (seen.has(member)) context.addIssue({ code: 'custom', path: [index], message: 'Duplicate member' });
        seen.add(member);
      });
    }),
});

export type Segment = Readonly<Omit<z.infer<typeof segmentContract>, 'members'>> & {
  readonly members: readonly string[];
};

export class SegmentValidationError extends Error {
  override readonly name = 'SegmentValidationError';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`Invalid segment:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`);
  }
}

export function parseSegment(input: unknown): Result<Segment, SegmentValidationError> {
  const parsed = segmentContract.safeParse(input);
  if (!parsed.success) return err(new SegmentValidationError(toIssues(parsed.error.issues)));
  Object.freeze(parsed.data.members);
  return ok(Object.freeze(parsed.data));
}
