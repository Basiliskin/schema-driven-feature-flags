import { checkForUpdates, expandFlag, expect, SEED, test } from './support/fixtures.js';

test.describe('someone else publishes while the page is open', () => {
  test('shows the update banner and lists what changed', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    await expect(page.getByRole('button', { name: 'Review changes' })).toBeHidden();

    env.publishAs('bob', { ...SEED, 'new-dashboard': { type: 'boolean', enabled: false } });
    await checkForUpdates(page);

    await expect(page.getByText('Someone published version 2 after you opened this page.')).toBeVisible();
    await page.getByRole('button', { name: 'Review changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'What changed' });
    await expect(dialog.getByText('published by bob')).toBeVisible();
    await expect(dialog.locator('[data-changed-key="new-dashboard"]')).toContainText('changed');
  });

  test('carries unsaved edits onto the latest version', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    const dialog = await expandFlag(page, 'checkout-limits');
    await dialog.getByLabel('Default JSON').fill('{"max": 5}');
    // The dialog overlays the whole page; close it (the edit stays in the field it moves back to) before
    // reaching for controls behind it.
    await dialog.getByRole('button', { name: 'Close' }).click();

    env.publishAs('bob', { ...SEED, 'dark-mode': { type: 'boolean', enabled: true } });
    await checkForUpdates(page);
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.getByRole('button', { name: 'Load latest, keep my edits' }).click();

    await expect(page.getByText('Your unsaved edits were reapplied on top of version 2.')).toBeVisible();
    await expect(page.locator('[data-flag="checkout-limits"]').getByLabel('Default JSON')).toHaveValue('{"max": 5}');
  });

  test('stages a rollout edit even though a different field changed concurrently, and it survives to publish', async ({ page, env, openEnvironment }) => {
    const rule = { when: { plan: 'pro' }, enabled: true };
    // Rollouts only exist from schemaVersion 2, which publishAs does not write.
    const publishV2 = (createdBy: string, enabled: boolean) =>
      env.publish({
        schemaVersion: 2,
        createdBy,
        reason: 'Other change',
        features: { ...SEED, 'new-dashboard': { type: 'boolean', enabled, rules: [rule] } },
      });
    publishV2('alice', true);
    await openEnvironment();
    publishV2('bob', false);

    const dialog = await expandFlag(page, 'new-dashboard');
    await dialog.locator('details.rollouts > summary').click();
    const rollout = dialog.locator('.rule-rollout');
    await rollout.getByLabel('Rollout', { exact: true }).check();
    await rollout.getByLabel('Percentage').fill('25');
    await rollout.getByLabel('Salt').fill('autumn');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // Staging never checks the current version — drift, if any, is surfaced later by the Review dialog,
    // which staging opens automatically.
    await expect(page.getByText('Staged. Review your pending changes and choose Update to publish them.')).toBeVisible();
    await page.getByRole('dialog', { name: 'Review pending changes' }).getByRole('button', { name: 'Update' }).click();

    // The single Save resubmits every visible field together, including Enabled exactly as the page
    // rendered it (checked, from before bob's concurrent publish) — a real trade-off of one combined
    // form: touching only the rollout still re-asserts the page's stale view of every other field.
    expect(env.features()['new-dashboard']).toEqual({
      type: 'boolean',
      enabled: true,
      rules: [{ ...rule, rollout: { percentage: 25, bucketBy: 'userId', salt: 'autumn' } }],
    });
  });

  test('offers a review when the edited flag was deleted meanwhile', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    env.publishAs('bob', Object.fromEntries(Object.entries(SEED).filter(([key]) => key !== 'dark-mode')));

    const flagDialog = await expandFlag(page, 'dark-mode');
    await flagDialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete dark-mode' }).getByRole('button', { name: 'Delete dark-mode' }).click();

    await expect(page.getByText('Someone else published version 2 meanwhile, so your edit was not saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Review changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'What changed' });
    await expect(dialog.getByText('This flag was deleted, so your edit to it can’t be applied.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Keep my edit and review it' })).toBeHidden();
    expect(env.currentVersion).toBe(2);
  });
});

test.describe('merging a pasted snapshot that lost the race', () => {
  test('merges field by field, asks only about real conflicts, then publishes', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    env.publishAs('bob', {
      ...SEED,
      'new-dashboard': { type: 'boolean', enabled: false },
      'checkout-limits': { type: 'config', enabled: false, default: { max: 9 } },
    });

    await page.getByRole('button', { name: 'Publish new version' }).click();
    const publish = page.getByRole('dialog', { name: 'Publish a new version' });
    const draft = JSON.parse(await publish.getByLabel('Snapshot JSON').inputValue()) as { features: Record<string, Record<string, unknown>> };
    draft.features['checkout-limits'] = { type: 'config', enabled: true, default: { max: 5 } };
    draft.features['new-dashboard'] = { type: 'boolean', enabled: true, rules: [{ when: { plan: 'pro' }, enabled: true }] };
    await publish.getByLabel('Snapshot JSON').fill(JSON.stringify(draft, null, 2));
    await publish.getByRole('button', { name: 'Publish', exact: true }).click();

    await expect(page.getByText('Your snapshot draft was based on version 1')).toBeVisible();
    await page.getByRole('button', { name: 'Review changes' }).click();
    const merge = page.getByRole('dialog', { name: 'Merge your draft' });
    await expect(merge.locator('[data-merge-key="new-dashboard"]')).toContainText('combined field by field');
    const limits = merge.locator('[data-merge-key="checkout-limits"]');
    await expect(limits).toContainText('conflict');

    // The one real conflict has no default, so applying is refused until it is chosen.
    await merge.getByRole('button', { name: 'Apply to my draft' }).click();
    await expect(merge.getByText('Choose a side for every conflict first.')).toBeVisible();
    await expect(limits.locator('[data-merge-field="default"]')).toHaveClass(/is-missing/);

    await limits.locator('[data-merge-field="default"]').getByLabel('Take version 2').check();
    await merge.getByRole('button', { name: 'Apply to my draft' }).click();
    await expect(publish).toBeVisible();
    await publish.getByRole('button', { name: 'Publish', exact: true }).click();

    await expect(page.getByText('Published version 3 to production.')).toBeVisible();
    expect(env.features()).toMatchObject({
      'checkout-limits': { type: 'config', enabled: true, default: { max: 9 } },
      'new-dashboard': { type: 'boolean', enabled: false, rules: [{ when: { plan: 'pro' }, enabled: true }] },
    });
  });
});
