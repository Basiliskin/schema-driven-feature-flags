import type { z } from 'zod';
import type { BooleanFeature, ConfigFeature, Feature } from '../feature.js';
import type { Condition, OperatorExpression } from '../rule.js';
import type { DeepReadonly } from '../snapshot.js';
import { isOperatorName, isScalar, operators, type Scalar } from './operators.js';

export type EvaluationReason = 'RULE_MATCH' | 'DEFAULT' | 'DISABLED' | 'INVALID_CONTEXT';

export interface EvaluationResult<Value> {
  readonly value: Value;
  readonly enabled: boolean;
  readonly reason: EvaluationReason;
  readonly ruleIndex?: number;
}

export interface EvaluateOptions {
  readonly contextSchema?: z.ZodType;
}

type Attributes = Readonly<Record<string, unknown>>;
type ConfigValue = DeepReadonly<ConfigFeature['default']>;

export function evaluate(
  feature: DeepReadonly<BooleanFeature>,
  context: unknown,
  options?: EvaluateOptions,
): EvaluationResult<boolean>;
export function evaluate(
  feature: DeepReadonly<Feature>,
  context: unknown,
  options?: EvaluateOptions,
): EvaluationResult<ConfigValue>;
export function evaluate(
  feature: DeepReadonly<Feature>,
  context: unknown,
  options: EvaluateOptions = {},
): EvaluationResult<ConfigValue> {
  if (!feature.enabled) {
    return { value: feature.type === 'boolean' ? false : feature.default, enabled: false, reason: 'DISABLED' };
  }
  const fallback = feature.type === 'boolean' ? feature.rules.length === 0 : feature.default;
  const resolve = (value: ConfigValue, reason: EvaluationReason) => ({
    value,
    enabled: feature.type === 'config' || value === true,
    reason,
  });

  const attributes = resolveAttributes(context, options.contextSchema);
  if (attributes === undefined) return resolve(fallback, 'INVALID_CONTEXT');

  const ruleIndex = feature.rules.findIndex((rule) => conditionMatches(rule.when, attributes));
  const rule = feature.rules[ruleIndex];
  if (rule === undefined) return resolve(fallback, 'DEFAULT');
  return { ...resolve('enabled' in rule ? rule.enabled : rule.value, 'RULE_MATCH'), ruleIndex };
}

function resolveAttributes(context: unknown, contextSchema: z.ZodType | undefined): Attributes | undefined {
  if (contextSchema === undefined) return toAttributes(context);
  const parsed = contextSchema.safeParse(context);
  return parsed.success ? toAttributes(parsed.data) : undefined;
}

const toAttributes = (value: unknown): Attributes =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Attributes) : {};

const conditionMatches = (when: DeepReadonly<Condition>, attributes: Attributes): boolean =>
  Object.entries(when).every(([attribute, expected]) => {
    const actual = Object.hasOwn(attributes, attribute) ? attributes[attribute] : undefined;
    return isScalar(actual) && expressionMatches(actual, isScalar(expected) ? { equals: expected } : expected);
  });

const expressionMatches = (actual: Scalar, expression: DeepReadonly<OperatorExpression>): boolean =>
  Object.entries(expression).every(
    ([name, operand]) => isOperatorName(name) && operators[name].matches(actual, operand as never),
  );
