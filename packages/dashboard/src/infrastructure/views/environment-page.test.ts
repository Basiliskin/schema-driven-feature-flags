import { parseSnapshot } from '@featuresync/core';
import { describe, expect, it } from 'vitest';
import type { EnvironmentView } from '../../application/browse-environment.js';
import { renderEnvironmentPage } from './environment-page.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

const prefilledSnapshot = (html: string): Record<string, unknown> => {
  const textarea = /<textarea id="snapshot"[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  if (textarea === null) throw new Error('the page rendered no snapshot textarea');
  const text = (textarea[1] as string).replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ENTITIES[entity] as string);
  return JSON.parse(text) as Record<string, unknown>;
};

const publishedView = (schemaVersion: number): EnvironmentView => {
  const raw = {
    schemaVersion,
    environment: 'production',
    version: 7,
    previousVersion: 6,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'someone',
    reason: 'A reason',
    features: {},
  };
  return {
    environment: 'production',
    status: 'published',
    currentVersion: 7,
    versions: [{ version: 7 }],
    current: {
      environment: 'production',
      version: 7,
      status: 'available',
      contents: { status: 'valid', flags: [], metadata: { createdAt: raw.createdAt, createdBy: raw.createdBy, reason: raw.reason }, segmentKeys: [], raw },
    },
  };
};

describe('the first version template', () => {
  it('prefills schemaVersion 2 so a new environment can hold segment rules', () => {
    const template = prefilledSnapshot(renderEnvironmentPage({ environment: 'production', status: 'empty' }));

    expect(template['schemaVersion']).toBe(2);
  });

  it('is a snapshot core accepts once the publisher stamps it', () => {
    const template = prefilledSnapshot(renderEnvironmentPage({ environment: 'production', status: 'empty' }));

    const result = parseSnapshot({ ...template, version: 1, previousVersion: null, createdAt: '2026-01-01T00:00:00.000Z' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.schemaVersion).toBe(2);
  });

  it('leaves an existing schemaVersion 1 environment on version 1', () => {
    const template = prefilledSnapshot(renderEnvironmentPage(publishedView(1)));

    expect(template['schemaVersion']).toBe(1);
  });
});
