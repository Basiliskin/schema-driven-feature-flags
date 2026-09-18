import { z } from 'zod';
import { operators, scalarSchema, type OperandOf, type OperatorName } from './evaluation/operators.js';

const operatorShape = Object.fromEntries(
  Object.entries(operators).map(([name, operator]) => [name, operator.operand.optional()]),
) as { [Name in OperatorName]: z.ZodOptional<z.ZodType<OperandOf<Name>>> };

export const operatorExpressionSchema = z
  .strictObject(operatorShape)
  .refine((expression) => Object.keys(expression).length === 1, 'Use exactly one operator per attribute');

export const conditionValueSchema = z.union([scalarSchema, operatorExpressionSchema]);

export const conditionSchema = z.record(z.string().min(1), conditionValueSchema);

export const booleanRuleSchema = z.strictObject({
  when: conditionSchema,
  enabled: z.boolean(),
});

export const configRuleSchema = z.strictObject({
  when: conditionSchema,
  value: z.json(),
});

export type OperatorExpression = z.infer<typeof operatorExpressionSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type BooleanRule = z.infer<typeof booleanRuleSchema>;
export type ConfigRule = z.infer<typeof configRuleSchema>;
