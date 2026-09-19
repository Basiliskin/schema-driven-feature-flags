import { describe, expect, it } from 'vitest';
import { applyFlagEdit, type FlagEditMeta } from '../../src/domain/flag-edit.js';

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
  baseVersion: 7,
  createdBy: 'dashboard',
  reason: 'toggle dark mode',
  now: new Date('2026-01-01T00:00:00.000Z'),
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

  it('sets the next-version metadata from meta rather than from the stored body', () => {
    const result = applyFlagEdit(rawText, { kind: 'enabled', key: 'dark-mode', enabled: true }, { ...meta, baseVersion: 12 });

    expect(result.ok && result.value).toMatchObject({
      version: 13,
      previousVersion: 12,
      createdAt: '2026-01-01T00:00:00.000Z',
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
      { ...meta, baseVersion: 0, createdBy: '' },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'INVALID_SNAPSHOT',
        issues: expect.arrayContaining([
          expect.stringMatching(/^createdBy: /),
          expect.stringMatching(/^previousVersion: /),
        ]) as unknown,
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
});
