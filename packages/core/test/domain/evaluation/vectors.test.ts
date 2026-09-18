import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../src/domain/evaluation/evaluate.js';
import { featureSchema } from '../../../src/domain/feature.js';

interface Vector {
  readonly name: string;
  readonly feature: unknown;
  readonly context: unknown;
  readonly expected: unknown;
}

const vectorsFile = new URL('../../../../../docs/spec/evaluation-vectors.json', import.meta.url);
const { vectors } = JSON.parse(readFileSync(vectorsFile, 'utf8')) as { vectors: Vector[] };

describe('shared evaluation vectors', () => {
  it('have unique names', () => {
    expect(new Set(vectors.map((vector) => vector.name)).size).toBe(vectors.length);
  });

  it.each(vectors)('$name', ({ feature, context, expected }) => {
    expect(evaluate(featureSchema.parse(feature), context)).toStrictEqual(expected);
  });
});
