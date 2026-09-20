export const SEED_SEGMENT_KEY = 'beta';
export const SEED_MEMBER_ATTRIBUTE = 'userId';

// schemaVersion 2 throughout: a Percentage Rollout is rejected on schemaVersion 1.
export const seedSnapshotFor = (environment: string) => ({
  schemaVersion: 2,
  environment,
  version: 1,
  createdAt: '2026-09-20T06:00:00.000Z',
  createdBy: 'integration',
  previousVersion: null,
  reason: 'seed',
  features: {
    checkout: {
      type: 'config',
      enabled: true,
      default: { provider: 'stripe' },
      rules: [
        { when: { [SEED_MEMBER_ATTRIBUTE]: { inSegment: SEED_SEGMENT_KEY } }, value: { provider: 'adyen' } },
      ],
    },
  },
});

export const seedPointerFor = (environment: string) => ({
  schemaVersion: 1,
  environment,
  version: 1,
  snapshotKey: `${environment}/snapshots/1.json`,
});
