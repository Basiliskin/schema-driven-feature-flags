import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { vi } from 'vitest';
import type { SnapshotWriter } from '../../src/application/publish-snapshot.js';
import type { DashboardPorts, RunningDashboard } from '../../src/infrastructure/http-server.js';

export const snapshotText = (features: Record<string, unknown>) =>
  JSON.stringify({
    schemaVersion: 1,
    environment: 'production',
    version: 1,
    createdAt: '2026-09-19T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: null,
    reason: 'test',
    features,
  });

export const VALID = snapshotText({
  'new-dashboard': { type: 'boolean', enabled: true },
  'checkout-limits': { type: 'config', enabled: false, default: { max: 3 } },
});


export const publishError = (reason: string) => Object.assign(new Error(reason), { name: 'S3PublishError', reason });

export interface Fakes {
  readonly ports: DashboardPorts;
  readonly writer: { publish: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> };
  readonly openWriter: ReturnType<typeof vi.fn>;
}

export const fakes = (overrides: Partial<DashboardPorts> = {}, writer: Partial<SnapshotWriter> = {}): Fakes => {
  const fakeWriter = {
    publish: vi.fn(writer.publish ?? (() => Promise.resolve(4))),
    rollback: vi.fn(writer.rollback ?? ((_env: string, version: number) => Promise.resolve(version))),
  };
  const openWriter = vi.fn(() => fakeWriter);
  return {
    writer: fakeWriter,
    openWriter,
    ports: {
      readCurrentVersion: () => Promise.resolve(3),
      fetchSnapshotText: () => Promise.resolve(VALID),
      listPublishedSegments: () => Promise.resolve({ status: 'listed', segments: [] }),
      publishSegment: () => Promise.reject(new Error('not used here')),
      readSegmentVersion: () => Promise.resolve(null),
      openWriter,
      ...overrides,
    },
  };
};

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export const call = (
  dashboard: RunningDashboard,
  method: string,
  path: string,
  options: { body?: string; headers?: OutgoingHttpHeaders; sameOrigin?: boolean } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(options.sameOrigin === false ? {} : { origin: dashboard.url }),
      ...options.headers,
    };
    const outgoing = httpRequest(new URL(path, dashboard.url), { method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });

export const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
