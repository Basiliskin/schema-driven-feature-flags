import { describe, expect, it } from 'vitest';
import { parseSnapshot, SnapshotValidationError } from '../src/index.js';
import { validSnapshot } from './domain/fixtures.js';

describe('parseSnapshot from the package entry point', () => {
  it('accepts a valid snapshot', () => {
    const result = parseSnapshot(validSnapshot());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(44);
  });

  it('returns field-level issues for an invalid snapshot', () => {
    const result = parseSnapshot({ ...validSnapshot(), version: 'forty-four' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(SnapshotValidationError);
    const issue = result.error.issues.find((i) => i.path === 'version');
    expect(issue?.message.trim()).not.toBe('');
    expect(issue?.message).toBeDefined();
  });
});
