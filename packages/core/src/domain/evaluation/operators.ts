import { z } from 'zod';

export const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export type Scalar = z.infer<typeof scalarSchema>;

export interface Operator<Operand> {
  readonly operand: z.ZodType<Operand>;
  readonly matches: (actual: Scalar, operand: Operand) => boolean;
}

const defineOperator = <Operand>(
  operand: z.ZodType<Operand>,
  matches: (actual: Scalar, operand: Operand) => boolean,
): Operator<Operand> => ({ operand, matches });

export const operators = {
  equals: defineOperator(scalarSchema, (actual, expected) => actual === expected),
  notEquals: defineOperator(scalarSchema, (actual, expected) => actual !== expected),
  in: defineOperator(z.array(scalarSchema).min(1), (actual, candidates) => candidates.includes(actual)),
};

export type OperatorName = keyof typeof operators;

export type OperandOf<Name extends OperatorName> = z.output<(typeof operators)[Name]['operand']>;

export const isOperatorName = (name: string): name is OperatorName => Object.hasOwn(operators, name);

export const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
