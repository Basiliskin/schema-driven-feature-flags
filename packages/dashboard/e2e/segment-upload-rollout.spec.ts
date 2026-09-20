import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { SEED_MEMBER_ATTRIBUTE, SEED_SEGMENT_KEY } from '../test/support/seed-snapshot.js';
import { expect, test } from './support/localstack-fixtures.js';

const MEMBERS = ['u-1', 'u-2', 'u-3'];
const CSV = [SEED_MEMBER_ATTRIBUTE, ...MEMBERS].join('\n');
const SEED_FLAG = 'checkout';

const readJson = async (s3: S3Client, bucket: string, key: string): Promise<Record<string, unknown>> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await (object.Body as { transformToString(): Promise<string> }).transformToString()) as Record<
    string,
    unknown
  >;
};

test.describe.serial('segment upload and rollout edit against LocalStack', () => {
  test('uploads a CSV through the browser file picker and publishes a Segment Version', async ({
    page,
    s3,
    bucket,
    environment,
    dashboard,
  }) => {
    await page.goto(`${dashboard.url}/env/${environment}/segments/${SEED_SEGMENT_KEY}`);

    await page
      .locator('[data-segment-file]')
      .setInputFiles({ name: 'members.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.getByRole('button', { name: 'Upload members' }).click();

    await expect(page.getByText('Uploaded as version 1.')).toBeVisible();

    const pointerKey = `${environment}/segments/${SEED_SEGMENT_KEY}/current.json`;
    const pointer = await readJson(s3, bucket, pointerKey);
    expect(pointer.version).toBe(1);
    expect(pointer.segmentKey).toBe(SEED_SEGMENT_KEY);

    const version = await readJson(s3, bucket, pointer.objectKey as string);
    expect(version.memberAttribute).toBe(SEED_MEMBER_ATTRIBUTE);
    expect(version.members).toEqual(MEMBERS);
  });

  test('saves a percentage rollout on a rule and publishes it into the next snapshot', async ({
    page,
    s3,
    bucket,
    environment,
    dashboard,
  }) => {
    await page.goto(`${dashboard.url}/env/${environment}`);

    const row = page.locator(`[data-flag="${SEED_FLAG}"]`);
    await row.locator('.flag-row > summary').click();
    await row.locator('details.rollouts > summary').click();

    const rollout = row.locator('.rule-rollout');
    await rollout.getByLabel('Percentage').fill('25');
    await rollout.getByLabel('Bucket by').fill(SEED_MEMBER_ATTRIBUTE);
    await rollout.getByLabel('Salt').fill('autumn');
    await rollout.getByRole('button', { name: 'Save rollout' }).click();

    await expect(page.getByText(`Published version 2 to ${environment}.`)).toBeVisible();
    await expect(row.locator('.badge-rollout')).toHaveText(`25% by ${SEED_MEMBER_ATTRIBUTE}`);

    const pointer = await readJson(s3, bucket, `${environment}/current.json`);
    expect(pointer.version).toBe(2);

    const snapshot = await readJson(s3, bucket, pointer.snapshotKey as string);
    const { features } = snapshot as { features: Record<string, { rules: { rollout?: unknown }[] }> };
    expect(features[SEED_FLAG]?.rules[0]?.rollout).toEqual({
      percentage: 25,
      bucketBy: SEED_MEMBER_ATTRIBUTE,
      salt: 'autumn',
    });
  });
});
