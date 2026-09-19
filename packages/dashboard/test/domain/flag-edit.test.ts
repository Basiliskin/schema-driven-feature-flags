import { describe, expect, it } from 'vitest';
import { applyFlagEdit, canReplayEdit, type FlagEditMeta } from '../../src/domain/flag-edit.js';

const baseSnapshot = {
  schemaVersion: 1,
  environment: 'production',
  version: 7,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'ci',
  previousVersion: 6,
  reason: 'seed',
  features: {
    'new-dashboard': { type: 'boolean', enabled: true, rules: [{ when: { plan: 'pro' }, enabled: false }] },
    'dark-mode': { type: 'boolean', enabled: false },
    'checkout-limits': { type: 'config', enabled: true, default: { max: 3 } },
  },
};
const rawText = JSON.stringify(baseSnapshot);

const meta: FlagEditMeta = {
  createdBy: 'dashboard',
  reason: 'toggle dark mode',
};

const features = (value: Record<string, unknown>) => value.features as Record<string, Record<string, unknown>>;

describe('applyFlagEdit', () => {
  it('flips only the target enabled flag and copies every other Feature and field unchanged', () => {
    const result = applyFlagEdit(rawText, { kind: 'enabled', key: 'dark-mode', enabled: true }, meta);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = features(result.value);
    expect(next['dark-mode']).toEqual({ type: 'boolean', enabled: true });
    expect(Object.hasOwn(next['dark-mode'] ?? {}, 'rules')).toBe(false);
    expect(JSON.stringify(next['new-dashboard'])).toBe(JSON.stringify(baseSnapshot.features['new-dashboard']));
    expect(JSON.stringify(next['checkout-limits'])).toBe(JSON.stringify(baseSnapshot.features['checkout-limits']));
    expect(result.value.schemaVersion).toBe(1);
    expect(result.value.environment).toBe('production');
    expect(Object.keys(result.value)).toEqual(Object.keys(baseSnapshot));
  });

  it('replaces only the default of a config Feature with the parsed JSON value', () => {
    const result = applyFlagEdit(rawText, { kind: 'default', key: 'checkout-limits', defaultJson: '{"max":5}' }, meta);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = features(result.value);
    expect(next['checkout-limits']).toEqual({ type: 'config', enabled: true, default: { max: 5 } });
    expect(Object.hasOwn(next['checkout-limits'] ?? {}, 'rules')).toBe(false);
    expect(next['dark-mode']).toEqual(baseSnapshot.features['dark-mode']);
    expect(next['new-dashboard']).toEqual(baseSnapshot.features['new-dashboard']);
  });

  it('sets the authorship from meta and leaves the version metadata for the publisher to stamp', () => {
    const result = applyFlagEdit(rawText, { kind: 'enabled', key: 'dark-mode', enabled: true }, meta);

    expect(result.ok && result.value).toMatchObject({
      version: 7,
      previousVersion: 6,
      createdAt: '2026-09-19T06:00:00.000Z',
      createdBy: 'dashboard',
      reason: 'toggle dark mode',
    });
  });

  it('leaves the stored snapshot text untouched', () => {
    const before = rawText;
    applyFlagEdit(rawText, { kind: 'enabled', key: 'new-dashboard', enabled: false }, meta);
    expect(rawText).toBe(before);
    expect(JSON.parse(rawText)).toEqual(baseSnapshot);
  });

  it.each(['missing', 'constructor', 'toString', '__proto__'])('reports %s as an unknown Feature', (key) => {
    expect(applyFlagEdit(rawText, { kind: 'enabled', key, enabled: true }, meta)).toEqual({
      ok: false,
      error: { kind: 'UNKNOWN_FEATURE', key },
    });
  });

  it.each(['[]', '{}', '{"features":[]}'])('reports an unknown Feature when the body %s has no features map', (text) => {
    expect(applyFlagEdit(text, { kind: 'enabled', key: 'dark-mode', enabled: true }, meta)).toEqual({
      ok: false,
      error: { kind: 'UNKNOWN_FEATURE', key: 'dark-mode' },
    });
  });

  it('refuses a default edit on a boolean Feature', () => {
    expect(applyFlagEdit(rawText, { kind: 'default', key: 'dark-mode', defaultJson: 'true' }, meta)).toEqual({
      ok: false,
      error: { kind: 'DEFAULT_NOT_EDITABLE', key: 'dark-mode' },
    });
  });

  it('returns the parser message for a default that is not JSON', () => {
    const result = applyFlagEdit(rawText, { kind: 'default', key: 'checkout-limits', defaultJson: '{max:' }, meta);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('INVALID_DEFAULT_JSON');
    expect(result.error).toEqual({ kind: 'INVALID_DEFAULT_JSON', message: expect.stringMatching(/JSON/) as unknown });
  });

  it('returns path: message issues when the edited snapshot fails validation', () => {
    const result = applyFlagEdit(
      rawText,
      { kind: 'enabled', key: 'dark-mode', enabled: true },
      { ...meta, createdBy: '' },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'INVALID_SNAPSHOT',
        issues: [expect.stringMatching(/^createdBy: /)] as unknown,
      },
    });
  });

  it('rejects an unknown top-level field through validation instead of dropping it', () => {
    const result = applyFlagEdit(
      JSON.stringify({ ...baseSnapshot, extra: 1 }),
      { kind: 'enabled', key: 'dark-mode', enabled: true },
      meta,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'INVALID_SNAPSHOT', issues: [expect.stringMatching(/^\(root\): /)] });
  });

  describe('create', () => {
    it('adds a boolean Feature without a default and leaves every other Feature unchanged', () => {
      const result = applyFlagEdit(rawText, { kind: 'create', key: 'beta.v2_x', type: 'boolean', enabled: true }, meta);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const next = features(result.value);
      expect(next['beta.v2_x']).toEqual({ type: 'boolean', enabled: true });
      const rest = Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'beta.v2_x'));
      expect(JSON.stringify(rest)).toBe(JSON.stringify(baseSnapshot.features));
    });

    it('adds a config Feature with its parsed default', () => {
      const result = applyFlagEdit(
        rawText,
        { kind: 'create', key: 'limits', type: 'config', enabled: false, defaultJson: '{"max":1}' },
        meta,
      );

      expect(result.ok && features(result.value).limits).toEqual({ type: 'config', enabled: false, default: { max: 1 } });
    });

    it('defaults a config Feature without default text to null', () => {
      const result = applyFlagEdit(rawText, { kind: 'create', key: 'limits', type: 'config', enabled: true }, meta);

      expect(result.ok && features(result.value).limits).toEqual({ type: 'config', enabled: true, default: null });
    });

    it('refuses a key that already exists', () => {
      expect(
        applyFlagEdit(rawText, { kind: 'create', key: 'dark-mode', type: 'boolean', enabled: true }, meta),
      ).toEqual({ ok: false, error: { kind: 'FEATURE_EXISTS', key: 'dark-mode' } });
    });

    it.each(['bad/key', '', '-leading', 'has space', '__proto__'])('refuses the invalid key %j', (key) => {
      expect(applyFlagEdit(rawText, { kind: 'create', key, type: 'boolean', enabled: true }, meta)).toEqual({
        ok: false,
        error: { kind: 'INVALID_KEY', key },
      });
    });

    it('returns the parser message for a default that is not JSON', () => {
      const result = applyFlagEdit(
        rawText,
        { kind: 'create', key: 'limits', type: 'config', enabled: true, defaultJson: '{' },
        meta,
      );

      expect(result).toEqual({
        ok: false,
        error: { kind: 'INVALID_DEFAULT_JSON', message: expect.stringMatching(/JSON/) as unknown },
      });
    });

    it('creates the first Feature in a snapshot whose features map is empty', () => {
      const result = applyFlagEdit(
        JSON.stringify({ ...baseSnapshot, features: {} }),
        { kind: 'create', key: 'first', type: 'boolean', enabled: false },
        meta,
      );

      expect(result.ok && features(result.value)).toEqual({ first: { type: 'boolean', enabled: false } });
    });
  });

  describe('delete', () => {
    it('removes only the target Feature and keeps the order of the rest', () => {
      const result = applyFlagEdit(rawText, { kind: 'delete', key: 'dark-mode' }, meta);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const next = features(result.value);
      expect(Object.keys(next)).toEqual(['new-dashboard', 'checkout-limits']);
      expect(JSON.stringify(next['new-dashboard'])).toBe(JSON.stringify(baseSnapshot.features['new-dashboard']));
      expect(JSON.stringify(next['checkout-limits'])).toBe(JSON.stringify(baseSnapshot.features['checkout-limits']));
    });

    it.each(['missing', '__proto__'])('reports %s as an unknown Feature', (key) => {
      expect(applyFlagEdit(rawText, { kind: 'delete', key }, meta)).toEqual({
        ok: false,
        error: { kind: 'UNKNOWN_FEATURE', key },
      });
    });
  });

  describe('setRules', () => {
    it('replaces only the rules of the target Feature', () => {
      const rulesJson = '[{"when":{"country":{"in":["DE","FR"]}},"enabled":true}]';
      const result = applyFlagEdit(rawText, { kind: 'setRules', key: 'dark-mode', rulesJson }, meta);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const next = features(result.value);
      expect(next['dark-mode']).toEqual({ type: 'boolean', enabled: false, rules: JSON.parse(rulesJson) as unknown });
      expect(JSON.stringify(next['new-dashboard'])).toBe(JSON.stringify(baseSnapshot.features['new-dashboard']));
      expect(JSON.stringify(next['checkout-limits'])).toBe(JSON.stringify(baseSnapshot.features['checkout-limits']));
    });

    it('clears the rules with an empty array', () => {
      const result = applyFlagEdit(rawText, { kind: 'setRules', key: 'new-dashboard', rulesJson: '[]' }, meta);

      expect(result.ok && features(result.value)['new-dashboard']).toEqual({
        type: 'boolean',
        enabled: true,
        rules: [],
      });
    });

    it('returns the parser message for rules that are not JSON', () => {
      expect(applyFlagEdit(rawText, { kind: 'setRules', key: 'dark-mode', rulesJson: '[{' }, meta)).toEqual({
        ok: false,
        error: { kind: 'INVALID_RULES_JSON', message: expect.stringMatching(/JSON/) as unknown },
      });
    });

    it('reports rules that break the schema as path: message issues', () => {
      const result = applyFlagEdit(
        rawText,
        { kind: 'setRules', key: 'checkout-limits', rulesJson: '[{"when":{"plan":"pro"},"enabled":true}]' },
        meta,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('INVALID_SNAPSHOT');
      expect(result.error).toMatchObject({
        issues: expect.arrayContaining([expect.stringMatching(/^features\.checkout-limits\.rules\[0\]/)]) as unknown,
      });
    });

    it('reports an unknown Feature', () => {
      expect(applyFlagEdit(rawText, { kind: 'setRules', key: 'missing', rulesJson: '[]' }, meta)).toEqual({
        ok: false,
        error: { kind: 'UNKNOWN_FEATURE', key: 'missing' },
      });
    });
  });
});

describe('canReplayEdit', () => {
  const snapshot = (features: Record<string, unknown>) => JSON.stringify({ features });
  const limits = { type: 'config', enabled: false, default: { max: 3 }, rules: [] };
  const base = snapshot({ limits, beta: { type: 'boolean', enabled: true } });

  it('replays an edit when only other fields or other flags changed', () => {
    const latest = snapshot({ limits: { ...limits, rules: [{ when: {} }] }, beta: { type: 'boolean', enabled: false } });
    expect(canReplayEdit(base, latest, { kind: 'enabled', key: 'limits', enabled: true })).toBe(true);
    expect(canReplayEdit(base, latest, { kind: 'default', key: 'limits', defaultJson: '{}' })).toBe(true);
  });

  it('refuses when the field the edit touches changed', () => {
    const latest = snapshot({ limits: { ...limits, enabled: true } });
    expect(canReplayEdit(base, latest, { kind: 'enabled', key: 'limits', enabled: false })).toBe(false);
    const rules = snapshot({ limits: { ...limits, rules: [{ when: {} }] } });
    expect(canReplayEdit(base, rules, { kind: 'setRules', key: 'limits', rulesJson: '[]' })).toBe(false);
  });

  it('refuses a default edit after a type change', () => {
    const latest = snapshot({ limits: { type: 'boolean', enabled: false, default: { max: 3 }, rules: [] } });
    expect(canReplayEdit(base, latest, { kind: 'default', key: 'limits', defaultJson: '{}' })).toBe(false);
  });

  it('refuses any edit to a flag deleted meanwhile, and a delete of a flag changed meanwhile', () => {
    expect(canReplayEdit(base, snapshot({}), { kind: 'enabled', key: 'limits', enabled: true })).toBe(false);
    const latest = snapshot({ limits: { ...limits, enabled: true } });
    expect(canReplayEdit(base, latest, { kind: 'delete', key: 'limits' })).toBe(false);
    expect(canReplayEdit(base, base, { kind: 'delete', key: 'limits' })).toBe(true);
  });

  it('refuses when either snapshot is not JSON with features', () => {
    expect(canReplayEdit('{', base, { kind: 'delete', key: 'limits' })).toBe(false);
    expect(canReplayEdit(base, '{"features":1}', { kind: 'delete', key: 'limits' })).toBe(false);
  });

  it('replays a create while the key was free when the edit was made', () => {
    expect(canReplayEdit(base, base, { kind: 'create', key: 'fresh', type: 'boolean', enabled: true })).toBe(true);
    expect(canReplayEdit(base, base, { kind: 'create', key: 'beta', type: 'boolean', enabled: true })).toBe(false);
  });
});
