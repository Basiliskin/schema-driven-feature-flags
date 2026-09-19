import { describe, expect, it } from 'vitest';
import { SnapshotValidationError } from '../../src/domain/errors.js';
import { parseSnapshot, type Snapshot } from '../../src/domain/snapshot.js';
import { paymentFlow, validSnapshot } from './fixtures.js';

const parseOk = (input: unknown, ...rest: Parameters<typeof parseSnapshot> extends [unknown, ...infer R] ? R : never) => {
  const result = parseSnapshot(input, ...rest);
  if (!result.ok) throw result.error;
  return result.value;
};

const issuesOf = (input: unknown, definitions = [paymentFlow]) => {
  const result = parseSnapshot(input, { definitions });
  if (result.ok) throw new Error('expected validation to fail');
  expect(result.error).toBeInstanceOf(SnapshotValidationError);
  return result.error.issues;
};

describe('parseSnapshot', () => {
  it('parses a valid snapshot', () => {
    const snapshot = parseOk(validSnapshot(), { definitions: [paymentFlow] });

    expect(snapshot.version).toBe(44);
    expect(snapshot.features['payment-flow']?.type).toBe('config');
  });

  it('round-trips through JSON unchanged', () => {
    const snapshot = parseOk(JSON.parse(JSON.stringify(validSnapshot())));

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(validSnapshot());
  });

  it('defaults missing rules to an empty list', () => {
    const snapshot = parseOk({ ...validSnapshot(), features: { 'new-dashboard': { type: 'boolean', enabled: true } } });

    expect(snapshot.features['new-dashboard']?.rules).toEqual([]);
  });

  it('accepts a first version without a predecessor', () => {
    expect(parseSnapshot({ ...validSnapshot(), version: 1, previousVersion: null }).ok).toBe(true);
  });

  it('freezes the snapshot at every depth', () => {
    const snapshot = parseOk(validSnapshot());
    const feature = snapshot.features['payment-flow'];
    if (feature?.type !== 'config') throw new Error('fixture mismatch');
    const value = feature.rules[0]?.value as Record<string, unknown>;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(feature.rules)).toBe(true);
    expect(() => {
      value.maxAmount = 1;
    }).toThrow(TypeError);
    expect(() => {
      (feature.rules as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('prevents mutation at the type level', () => {
    const mutate = (snapshot: Snapshot) => {
      // @ts-expect-error snapshot fields are readonly
      snapshot.version = 45;
      const feature = snapshot.features['new-dashboard'];
      if (feature?.type === 'boolean') {
        // @ts-expect-error nested rules are readonly
        feature.rules[0] = { when: {}, enabled: false };
      }
    };

    expect(() => {
      mutate(parseOk(validSnapshot()));
    }).toThrow(TypeError);
  });

  it('does not mutate the input it was given', () => {
    const input = validSnapshot();
    parseOk(input);

    expect(Object.isFrozen(input)).toBe(false);
  });

  it.each([
    ['non-object input', 'nope', '(root)'],
    ['unsupported schemaVersion', { ...validSnapshot(), schemaVersion: 3 }, 'schemaVersion'],
    ['non-positive version', { ...validSnapshot(), version: 0 }, 'version'],
    ['fractional version', { ...validSnapshot(), version: 1.5 }, 'version'],
    ['non-ISO createdAt', { ...validSnapshot(), createdAt: 'yesterday' }, 'createdAt'],
    ['previousVersion not lower', { ...validSnapshot(), previousVersion: 44 }, 'previousVersion'],
    ['unknown top-level field', { ...validSnapshot(), extra: true }, '(root)'],
    ['invalid feature key', { ...validSnapshot(), features: { 'bad key': validSnapshot().features['new-dashboard'] } }, 'features.bad key'],
  ])('rejects %s', (_label, input, path) => {
    expect(issuesOf(input, []).map((issue) => issue.path)).toContain(path);
  });

  it('names the feature and field path of an invalid rule', () => {
    const input = validSnapshot();
    input.features['new-dashboard'].rules[0] = { when: { isEmployee: true }, enabled: 'yes' as unknown as boolean };

    expect(issuesOf(input, []).map((issue) => issue.path)).toEqual(['features.new-dashboard.rules[0].enabled']);
  });

  it('rejects non-JSON config values', () => {
    const input = validSnapshot();
    input.features['payment-flow'].default = { provider: 'stripe', maxAmount: Number.NaN, require3ds: true };

    expect(issuesOf(input, []).map((issue) => issue.path)).toEqual(['features.payment-flow.default']);
  });

  describe('with feature definitions', () => {
    it('names the path of a rule value that breaks the feature schema', () => {
      const input = validSnapshot();
      input.features['payment-flow'].rules = [
        { when: { plan: 'enterprise' }, value: { provider: 'adyen', maxAmount: 'lots' as unknown as number, require3ds: false } },
      ];

      const issues = issuesOf(input);

      expect(issues.map((issue) => issue.path)).toEqual(['features.payment-flow.rules[0].value.maxAmount']);
      expect(issues[0]?.message).toMatch(/number/);
    });

    it('checks the snapshot default against the schema', () => {
      const input = validSnapshot();
      input.features['payment-flow'].default.provider = 'paypal';

      expect(issuesOf(input).map((issue) => issue.path)).toEqual(['features.payment-flow.default.provider']);
    });

    it('rejects a boolean feature registered as config', () => {
      const input = validSnapshot();
      const dashboard = input.features['new-dashboard'];

      const issues = issuesOf({ ...input, features: { 'new-dashboard': dashboard, 'payment-flow': dashboard } });

      expect(issues).toEqual([{ path: 'features.payment-flow.type', message: 'Expected a config feature' }]);
    });

    it('ignores definitions for features absent from the snapshot', () => {
      const input = validSnapshot();
      const features = { 'new-dashboard': input.features['new-dashboard'] };

      expect(parseSnapshot({ ...input, features }, { definitions: [paymentFlow] }).ok).toBe(true);
    });
  });

  it('lists every issue in the error message', () => {
    const error = issuesOf({ ...validSnapshot(), environment: '', createdBy: '' }, []);

    expect(error.map((issue) => issue.path)).toEqual(['environment', 'createdBy']);
    const result = parseSnapshot({ ...validSnapshot(), version: 0 });
    expect(result.ok ? '' : result.error.message).toMatch(/^Invalid snapshot:\n {2}version: /);
  });
});
