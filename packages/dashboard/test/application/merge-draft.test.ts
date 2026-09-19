import { describe, expect, it } from 'vitest';
import { applyDraftMerge, mergeDraft } from '../../src/application/merge-draft.js';

const snapshot = (features: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, features });
const on = { type: 'boolean', enabled: true };
const off = { type: 'boolean', enabled: false };

const ports = (texts: Record<number, string>, current = 5) => ({
  readCurrentVersion: () => Promise.resolve(current),
  fetchSnapshotText: (_env: string, version: number) =>
    texts[version] === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(texts[version]),
});

describe('mergeDraft', () => {
  it('merges the draft against the version it started from and the latest', async () => {
    const result = await mergeDraft(ports({ 3: snapshot({ a: on }), 5: snapshot({ a: off }) }), 'production', 3, snapshot({ a: on }));
    expect(result).toEqual({ status: 'ready', from: 3, to: 5, entries: [{ key: 'a', status: 'theirs', base: on, mine: on, theirs: off }] });
  });

  it('refuses a draft that is not JSON with a features object', async () => {
    const p = ports({ 3: snapshot({}), 5: snapshot({}) });
    await expect(mergeDraft(p, 'production', 3, '{')).resolves.toEqual({ status: 'invalid-draft' });
    await expect(mergeDraft(p, 'production', 3, '{"features":[]}')).resolves.toEqual({ status: 'invalid-draft' });
  });

  it('is unavailable when the base snapshot cannot be read', async () => {
    await expect(mergeDraft(ports({ 5: snapshot({}) }), 'production', 3, snapshot({}))).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('applyDraftMerge', () => {
  const texts = { 3: snapshot({ a: on, b: on }), 5: snapshot({ a: off, b: off }) };
  const draft = JSON.stringify({ schemaVersion: 1, reason: 'mine', features: { a: on, b: { type: 'boolean', enabled: true, rules: [] } } }, null, 2);

  it('applies the choices server-side, keeping the rest of the draft', async () => {
    const result = await applyDraftMerge(ports(texts), 'production', 3, 5, draft, { b: { enabled: 'theirs' } });
    expect(result).toMatchObject({ status: 'merged', to: 5 });
    const merged = JSON.parse((result as { snapshotText: string }).snapshotText) as unknown;
    expect(merged).toEqual({ schemaVersion: 1, reason: 'mine', features: { a: off, b: { type: 'boolean', enabled: false, rules: [] } } });
  });

  it('reports conflicts left without a choice', async () => {
    const c = (max: number) => ({ c: { type: 'config', enabled: true, default: max } });
    const conflicting = { 3: snapshot(c(1)), 5: snapshot(c(9)) };
    const result = await applyDraftMerge(ports(conflicting), 'production', 3, 5, snapshot(c(5)), {});
    expect(result).toEqual({ status: 'missing', missing: ['c.default'] });
  });

  it('refuses when the latest version moved after the review', async () => {
    const result = await applyDraftMerge(ports({ ...texts, 6: snapshot({}) }, 6), 'production', 3, 5, draft, {});
    expect(result).toEqual({ status: 'moved', to: 6 });
  });
});

describe('merge edge cases', () => {
  it('is unavailable when nothing is published', async () => {
    const p = { readCurrentVersion: () => Promise.resolve(undefined), fetchSnapshotText: () => Promise.resolve('{}') };
    await expect(mergeDraft(p, 'production', 3, snapshot({}))).resolves.toEqual({ status: 'unavailable' });
  });

  it('passes an unmergeable draft straight back when applying', async () => {
    const p = ports({ 3: snapshot({}), 5: snapshot({}) });
    await expect(applyDraftMerge(p, 'production', 3, 5, 'not json', {})).resolves.toEqual({ status: 'invalid-draft' });
  });
});
