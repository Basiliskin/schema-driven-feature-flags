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
    const row = await expandFlag(page, 'checkout-limits');
    await row.getByLabel('Default JSON').fill('{"max": 5}');

    env.publishAs('bob', { ...SEED, 'dark-mode': { type: 'boolean', enabled: true } });
    await checkForUpdates(page);
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.getByRole('button', { name: 'Load latest, keep my edits' }).click();

    await expect(page.getByText('Your unsaved edits were reapplied on top of version 2.')).toBeVisible();
    await expect(page.locator('[data-flag="checkout-limits"]').getByLabel('Default JSON')).toHaveValue('{"max": 5}');
  });

  test('saves an edit on top of a change to a different field without asking', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    env.publishAs('bob', { ...SEED, 'checkout-limits': { type: 'config', enabled: true, default: { max: 3 } } });

    const row = await expandFlag(page, 'checkout-limits');
    await row.getByLabel('Default JSON').fill('{"max": 5}');
    await row.getByRole('button', { name: 'Save default' }).click();

    await expect(page.getByText('your edit was applied on top of it')).toBeVisible();
    expect(env.features()['checkout-limits']).toEqual({ type: 'config', enabled: true, default: { max: 5 } });
  });

  test('offers a review when the edited flag was deleted meanwhile', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    env.publishAs('bob', Object.fromEntries(Object.entries(SEED).filter(([key]) => key !== 'dark-mode')));

    const row = await expandFlag(page, 'dark-mode');
    await row.getByLabel('Enabled').check();
    await row.getByRole('button', { name: 'Save enabled' }).click();

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
