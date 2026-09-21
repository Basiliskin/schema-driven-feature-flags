import { randomUUID } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { expect, test } from './support/localstack-fixtures.js';

const SEED_FLAG = 'checkout';
const SEGMENT_ATTRIBUTE = 'accountId';
const SEGMENT_VERSION = 3;
const ATTACHED_VALUE = 'adyen';

// A fresh key per run, so a leftover object from an earlier run can neither satisfy nor break the listing.
const uniqueSegmentKey = (): string => `pilot-${randomUUID().slice(0, 8)}`;

const readJson = async (s3: S3Client, bucket: string, key: string): Promise<Record<string, unknown>> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await (object.Body as { transformToString(): Promise<string> }).transformToString()) as Record<
    string,
    unknown
  >;
};

test('lists a published segment and attaches it to a flag through the chooser', async ({
  page,
  s3,
  bucket,
  environment,
  dashboard,
  seedSegment,
}) => {
  const segmentKey = uniqueSegmentKey();
  await seedSegment({
    key: segmentKey,
    version: SEGMENT_VERSION,
    memberAttribute: SEGMENT_ATTRIBUTE,
    members: ['a-1', 'a-2'],
  });

  const segmentsUrl = `${dashboard.url}/env/${environment}/segments`;
  await page.goto(segmentsUrl);

  const row = page
    .locator('table.flag-table tbody tr')
    .filter({ has: page.getByRole('link', { name: segmentKey, exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-label="Current pointer"]')).toHaveText(`version ${String(SEGMENT_VERSION)}`);
  await expect(row.locator('[data-label="Member attribute"]')).toHaveText(SEGMENT_ATTRIBUTE);
  await expect(row.locator('[data-label="Used by flags"]')).toHaveText('used by no flag');

  await page.goto(`${dashboard.url}/env/${environment}`);
  const flag = page.locator(`[data-flag="${SEED_FLAG}"]`);
  await flag.locator('.flag-row > summary').click();

  const attach = flag.locator('details.segment-attach');
  await attach.locator('summary').click();
  await attach.getByLabel('Segment').selectOption(segmentKey);
  await attach.getByLabel('Value for members').fill(ATTACHED_VALUE);
  await attach.getByRole('button', { name: 'Attach segment' }).click();

  await expect(page.getByText(`Published version 2 to ${environment}.`)).toBeVisible();

  // The reload after the publish collapses every <details> again, so the flag has to be reopened.
  await flag.locator('.flag-row > summary').click();
  await flag.locator('details.rollouts > summary').click();
  await expect(flag.locator('.rule-segment').filter({ hasText: segmentKey })).toBeVisible();

  const snapshotPointer = await readJson(s3, bucket, `${environment}/current.json`);
  const snapshot = await readJson(s3, bucket, snapshotPointer.snapshotKey as string);
  const { features } = snapshot as {
    features: Record<string, { rules: { when: Record<string, unknown>; value?: unknown }[] }>;
  };
  expect(features[SEED_FLAG]?.rules.at(-1)).toEqual({
    when: { [SEGMENT_ATTRIBUTE]: { inSegment: segmentKey } },
    value: ATTACHED_VALUE,
  });

  await page.goto(segmentsUrl);
  await expect(row.locator('[data-label="Used by flags"]')).toHaveText(SEED_FLAG);
});
