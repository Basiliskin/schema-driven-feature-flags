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

  test('filters on the server when the form is submitted, and the URL reproduces the view', async ({ page, openEnvironment }) => {
    await openEnvironment();
    const rows = page.locator('[data-flag]');
    await expect(rows).toHaveCount(3);

    await page.getByRole('searchbox', { name: /Filter flags/ }).fill('dark');
    await page.getByRole('button', { name: 'Filter' }).click();

    await expect(rows).toHaveCount(1);
    await expect(page.locator('[data-flag="dark-mode"]')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('filter')).toBe('dark');

    await page.reload();
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole('searchbox', { name: /Filter flags/ })).toHaveValue('dark');

    await page.getByRole('searchbox', { name: /Filter flags/ }).fill('nothing-like-this');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(rows).toHaveCount(0);
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

test.describe('new flag dialog', () => {
  test('opens from the flags section and creates the flag', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    await expect(page.getByLabel('Key', { exact: true })).toBeHidden();

    await page.getByRole('button', { name: 'New flag' }).click();
    const dialog = page.getByRole('dialog', { name: 'New flag' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Key').fill('beta-search');
    await dialog.getByLabel('Enabled').check();
    await dialog.getByRole('button', { name: 'Create flag' }).click();

    await expect(page.locator('[data-flag="beta-search"]')).toBeVisible();
    expect(env.features()).toHaveProperty('beta-search');
  });

  test('re-opens with the typed draft and the error when the create is rejected', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    await page.getByRole('button', { name: 'New flag' }).click();
    const dialog = page.getByRole('dialog', { name: 'New flag' });

    await dialog.getByLabel('Key').fill('limits');
    await dialog.getByLabel('Type').selectOption('config');
    await dialog.getByLabel('Default JSON (config flags only)').fill('{');
    await dialog.getByRole('button', { name: 'Create flag' }).click();

    const reopened = page.getByRole('dialog', { name: 'New flag' });
    await expect(reopened).toBeVisible();
    await expect(reopened.getByText('The default value is not valid JSON.')).toBeVisible();
    await expect(reopened.getByLabel('Key')).toHaveValue('limits');
    await expect(reopened.getByLabel('Default JSON (config flags only)')).toHaveValue('{');
    expect(env.currentVersion).toBe(1);
  });
});
