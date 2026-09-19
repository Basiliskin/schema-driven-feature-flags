import { z } from 'zod';
import { operators, scalarSchema, type OperandOf, type OperatorName } from './evaluation/operators.js';
import { segmentKeySchema } from './segment-contract.js';

const operatorShape = {
  ...(Object.fromEntries(
    Object.entries(operators).map(([name, operator]) => [name, operator.operand.optional()]),
  ) as { [Name in OperatorName]: z.ZodOptional<z.ZodType<OperandOf<Name>>> }),
  inSegment: segmentKeySchema.optional(),
};

export const operatorExpressionSchema = z
  .strictObject(operatorShape)
  .refine((expression) => Object.keys(expression).length === 1, 'Use exactly one operator per attribute');

export const conditionValueSchema = z.union([scalarSchema, operatorExpressionSchema]);

export const conditionSchema = z.record(z.string().min(1), conditionValueSchema);

const hasAtMostTwoDecimals = (percentage: number): boolean =>
  Math.abs(percentage * 100 - Math.round(percentage * 100)) < 1e-9;

export const rolloutSchema = z.strictObject({
  percentage: z
    .number()
    .min(0)
    .max(100)
    .refine(hasAtMostTwoDecimals, 'Use at most two decimal places'),
  bucketBy: z.string().min(1),
  salt: z.string().min(1),
});

export const booleanRuleSchema = z.strictObject({
  when: conditionSchema,
  rollout: rolloutSchema.optional(),
  enabled: z.boolean(),
});

export const configRuleSchema = z.strictObject({
  when: conditionSchema,
  rollout: rolloutSchema.optional(),
  value: z.json(),
});

export type OperatorExpression = z.infer<typeof operatorExpressionSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Rollout = z.infer<typeof rolloutSchema>;
export type BooleanRule = z.infer<typeof booleanRuleSchema>;
export type ConfigRule = z.infer<typeof configRuleSchema>;
