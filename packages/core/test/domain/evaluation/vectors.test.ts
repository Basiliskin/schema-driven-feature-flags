import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeBucket } from '../../../src/domain/evaluation/bucket.js';
import { evaluate } from '../../../src/domain/evaluation/evaluate.js';
import { featureSchema, type Feature } from '../../../src/domain/feature.js';

interface Vector {
  readonly name: string;
  readonly flagKey?: string;
  readonly segments?: Readonly<Record<string, readonly string[]>>;
  readonly feature: unknown;
  readonly context: unknown;
  readonly bucket?: number;
  readonly expected: unknown;
}

const vectorsFile = new URL('../../../../../docs/spec/evaluation-vectors.json', import.meta.url);
const { vectors } = JSON.parse(readFileSync(vectorsFile, 'utf8')) as { vectors: Vector[] };

const toSegments = (segments: Vector['segments'] = {}) =>
  new Map(Object.entries(segments).map(([key, members]) => [key, new Set(members)]));

const pinnedBucket = (feature: Feature, flagKey: string, context: unknown): number | undefined => {
  const rollout = feature.rules.find((rule) => rule.rollout !== undefined)?.rollout;
  const attributes = context as Readonly<Record<string, unknown>>;
  return rollout && computeBucket(flagKey, rollout.salt, attributes[rollout.bucketBy]);
};

describe('shared evaluation vectors', () => {
  it('have unique names', () => {
    expect(new Set(vectors.map((vector) => vector.name)).size).toBe(vectors.length);
  });

  it.each(vectors)('$name', ({ flagKey, segments, feature, context, bucket, expected }) => {
    const parsed = featureSchema.parse(feature);
    if (bucket !== undefined) expect(pinnedBucket(parsed, flagKey ?? '', context)).toBe(bucket);
    expect(evaluate(parsed, context, { ...(flagKey && { flagKey }), segments: toSegments(segments) })).toStrictEqual(expected);
  });
});
