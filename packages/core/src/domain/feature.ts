import { z } from 'zod';
import { booleanRuleSchema, configRuleSchema } from './rule.js';

/** The shape every Feature key must have: letters, digits, ".", "_" or "-", starting with a letter or digit. */
export const FEATURE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const featureKeySchema = z
  .string()
  .regex(FEATURE_KEY_PATTERN, 'Feature keys use letters, digits, ".", "_" or "-"');

export const booleanFeatureSchema = z.strictObject({
  type: z.literal('boolean'),
  enabled: z.boolean(),
  rules: z.array(booleanRuleSchema).default([]),
});

export const configFeatureSchema = z.strictObject({
  type: z.literal('config'),
  enabled: z.boolean(),
  default: z.json(),
  rules: z.array(configRuleSchema).default([]),
});

export const featureSchema = z.discriminatedUnion('type', [booleanFeatureSchema, configFeatureSchema]);

export type BooleanFeature = z.infer<typeof booleanFeatureSchema>;
export type ConfigFeature = z.infer<typeof configFeatureSchema>;
export type Feature = z.infer<typeof featureSchema>;
