import { expandFlag, expect, test } from './support/fixtures.js';

test.describe('flag list', () => {
  test('shows each flag as a collapsed row that expands to its editor', async ({ page, openEnvironment }) => {
    await openEnvironment();
    await expect(page.locator('[data-flag="checkout-limits"]').getByRole('button', { name: 'Save default' })).toBeHidden();
    const row = await expandFlag(page, 'checkout-limits');
    await expect(row.getByRole('button', { name: 'Save default' })).toBeVisible();
  });

  test('filters flags by key, type and on/off as you type', async ({ page, openEnvironment }) => {
    await openEnvironment();
    const filter = page.getByRole('searchbox', { name: /Filter flags/ });
    const rows = page.locator('[data-flag]');

    await filter.fill('dark');
    await expect(rows.filter({ visible: true })).toHaveCount(1);
    await expect(page.locator('[data-flag="dark-mode"]')).toBeVisible();

    await filter.fill('boolean on');
    await expect(rows.filter({ visible: true })).toHaveCount(1);
    await expect(page.locator('[data-flag="new-dashboard"]')).toBeVisible();

    await filter.fill('nothing-like-this');
    await expect(page.getByText('No flags match.')).toBeVisible();
  });
});

test.describe('publish dialog', () => {
  test('opens from the header and publishes the edited snapshot', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    await page.getByRole('button', { name: 'Publish new version' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish a new version' });
    await expect(dialog).toBeVisible();

    const draft = JSON.parse(await dialog.getByLabel('Snapshot JSON').inputValue()) as { features: Record<string, unknown> };
    draft.features['beta-search'] = { type: 'boolean', enabled: true };
    await dialog.getByLabel('Snapshot JSON').fill(JSON.stringify(draft));
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click();

    await expect(page.getByText('Published version 2 to production.')).toBeVisible();
    expect(env.features()).toHaveProperty('beta-search');
  });
});
