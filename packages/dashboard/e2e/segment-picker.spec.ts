import { randomUUID } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Page } from '@playwright/test';
import { expect, test } from './support/localstack-fixtures.js';

/** Clicking a flag's name moves its row's own panel into the shared overlay dialog, which this returns. */
const openFlag = async (page: Page, key: string) => {
  await page.locator(`[data-flag="${key}"]`).getByRole('link', { name: key, exact: true }).click();
  return page.getByRole('dialog', { name: key, exact: true });
};

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
  let flagDialog = await openFlag(page, SEED_FLAG);

  const attach = flagDialog.locator('details.segment-attach');
  await attach.locator('summary').click();
  await attach.getByLabel('Segment').selectOption(segmentKey);
  await attach.getByLabel('Value for members').fill(ATTACHED_VALUE);
  await flagDialog.getByRole('button', { name: 'Save', exact: true }).click();

  // Attaching is staged, along with every other change on the flag, until Update publishes it.
  await expect(page.getByText('Staged. Review your pending changes and choose Update to publish them.')).toBeVisible();
  await page.getByRole('dialog', { name: 'Review pending changes' }).getByRole('button', { name: 'Update' }).click();
  await expect(page.getByText(`Published version 2 to ${environment}.`)).toBeVisible();

  // The write reloads the page with every flag panel collapsed again; the rollout panel nested inside it is
  // deliberately outside its own contract too, so both have to be opened by hand.
  flagDialog = await openFlag(page, SEED_FLAG);
  await flagDialog.locator('details.rollouts > summary').click();
  await expect(flagDialog.locator('.rule-segment').filter({ hasText: segmentKey })).toBeVisible();

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

test('detaches a segment only once Save is clicked, not by ticking the checkbox alone', async ({
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
    members: ['a-1'],
  });

  await page.goto(`${dashboard.url}/env/${environment}`);
  let flagDialog = await openFlag(page, SEED_FLAG);

  const attach = flagDialog.locator('details.segment-attach');
  await attach.locator('summary').click();
  await attach.getByLabel('Segment').selectOption(segmentKey);
  await attach.getByLabel('Value for members').fill(ATTACHED_VALUE);
  await flagDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review pending changes' }).getByRole('button', { name: 'Update' }).click();
  await expect(page.getByText(`Published version 2 to ${environment}.`)).toBeVisible();

  // The write reloads the page with every panel collapsed again, so the flag has to be reopened by hand.
  flagDialog = await openFlag(page, SEED_FLAG);
  await flagDialog.locator('details.rollouts > summary').click();
  const rule = flagDialog.locator('li.rule-rollout').filter({ hasText: segmentKey });
  await expect(rule.locator('.rule-segment')).toBeVisible();

  // Ticking Detach only stages the intent; nothing publishes until Save (and Update) run.
  await rule.getByLabel('Detach', { exact: true }).check();
  const stillAttached = await readJson(s3, bucket, `${environment}/current.json`);
  const beforeSnapshot = await readJson(s3, bucket, stillAttached.snapshotKey as string);
  expect(JSON.stringify(beforeSnapshot)).toContain(segmentKey);

  await flagDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review pending changes' }).getByRole('button', { name: 'Update' }).click();

  await expect(page.getByText(`Published version 3 to ${environment}.`)).toBeVisible();
  flagDialog = await openFlag(page, SEED_FLAG);
  await flagDialog.locator('details.rollouts > summary').click();
  await expect(flagDialog.locator('.rule-segment').filter({ hasText: segmentKey })).toHaveCount(0);

  const pointer = await readJson(s3, bucket, `${environment}/current.json`);
  const snapshot = await readJson(s3, bucket, pointer.snapshotKey as string);
  const { features } = snapshot as { features: Record<string, { rules: unknown[] }> };
  expect(JSON.stringify(features[SEED_FLAG]?.rules ?? [])).not.toContain(segmentKey);
});
