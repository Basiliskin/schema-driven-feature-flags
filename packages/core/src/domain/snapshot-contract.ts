import { z } from 'zod';
import { featureKeySchema, featureSchema } from './feature.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;

const versionSchema = z.int().positive();

export const snapshotContract = z
  .strictObject({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
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
  });

export type SnapshotData = z.infer<typeof snapshotContract>;
