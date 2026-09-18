import type { z } from 'zod';
import { FeatureDefinitionError, toIssues } from './errors.js';

export interface FeatureDefinition<
  Key extends string = string,
  Schema extends z.ZodType = z.ZodType,
  Context extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly key: Key;
  readonly schema: Schema;
  readonly default: z.output<Schema>;
  readonly context: Context;
}

export type ConfigOf<Definition extends FeatureDefinition> = z.output<Definition['schema']>;

export type ContextOf<Definition extends FeatureDefinition> =
  Definition['context'] extends z.ZodType ? z.output<Definition['context']> : Record<string, never>;

export function defineFeature<
  const Key extends string,
  Schema extends z.ZodType,
  Context extends z.ZodType | undefined = undefined,
>(options: {
  readonly key: Key;
  readonly schema: Schema;
  readonly default: z.input<Schema>;
  readonly context?: Context;
}): FeatureDefinition<Key, Schema, Context> {
  const parsed = options.schema.safeParse(options.default);
  if (!parsed.success) {
    throw new FeatureDefinitionError(options.key, toIssues(parsed.error.issues, ['default']));
  }
  return Object.freeze({
    key: options.key,
    schema: options.schema,
    default: parsed.data,
    context: options.context as Context,
  });
}
