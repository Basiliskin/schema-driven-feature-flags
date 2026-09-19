import { z } from 'zod';
import { featureKeySchema, featureSchema } from './feature.js';
import type { Condition } from './rule.js';

export const SNAPSHOT_SCHEMA_VERSIONS = [1, 2] as const;

const versionSchema = z.int().positive();

export const snapshotContract = z
  .strictObject({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSIONS),
    environment: z.string().min(1),
    version: versionSchema,
    createdAt: z.iso.datetime({ offset: true }),
    createdBy: z.string().min(1),
    previousVersion: versionSchema.nullable(),
    reason: z.string(),
    features: z.record(featureKeySchema, featureSchema),
  })
  .refine((snapshot) => snapshot.previousVersion === null || snapshot.previousVersion < snapshot.version, {
    path: ['previousVersion'],
    message: 'previousVersion must be lower than version',
  })
  .superRefine((snapshot, context) => {
    if (snapshot.schemaVersion !== 1) return;
    for (const [key, feature] of Object.entries(snapshot.features)) {
      feature.rules.forEach((rule, index) => {
        if (rule.rollout !== undefined || usesSegment(rule.when)) {
          context.addIssue({
            code: 'custom',
            path: ['features', key, 'rules', index],
            message: 'Segment conditions and rollouts need schemaVersion 2',
          });
        }
      });
    }
  });

const usesSegment = (when: Condition): boolean =>
  Object.values(when).some((condition) => typeof condition === 'object' && 'inSegment' in condition);

export type SnapshotData = z.infer<typeof snapshotContract>;
