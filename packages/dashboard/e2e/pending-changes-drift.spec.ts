import type { Page } from '@playwright/test';
import { expandFlag, expect, SEED, test } from './support/fixtures.js';

const REVIEW = 'Review pending changes';

const stageDarkModeOn = async (page: Page): Promise<void> => {
  const flagDialog = await expandFlag(page, 'dark-mode');
  await flagDialog.getByLabel('Enabled').check();
  await flagDialog.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: REVIEW });
  await expect(dialog.locator('.flag-key', { hasText: 'dark-mode' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
};

const reopenReview = async (page: Page) => {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('button', { name: REVIEW }).click();
  return page.getByRole('dialog', { name: REVIEW });
};

test.describe('a staged edit whose environment moved on underneath it', () => {
  test('warns about the drift but still lets the operator publish anyway', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    await stageDarkModeOn(page);
    expect(env.currentVersion).toBe(1);

    env.publishAs('bob', { ...SEED, 'new-dashboard': { type: 'boolean', enabled: false } });
    expect(env.currentVersion).toBe(2);

    const dialog = await reopenReview(page);
    await expect(dialog.getByText('This environment has moved on since version 1')).toBeVisible();
    await expect(dialog.locator('.flag-key', { hasText: 'dark-mode' })).toBeVisible();
    const publishAnyway = dialog.getByRole('button', { name: 'Publish anyway' });
    await expect(publishAnyway).toBeEnabled();

    const versionBefore = env.currentVersion;
    await publishAnyway.click();

    await expect(page.getByRole('button', { name: REVIEW })).toHaveCount(0);
    expect(env.currentVersion).toBe(versionBefore + 1);
    expect(env.features()).toMatchObject({ 'dark-mode': { type: 'boolean', enabled: true } });
  });

  test('discards the staged edit without publishing anything', async ({ page, env, openEnvironment }) => {
    await openEnvironment();
    await stageDarkModeOn(page);

    env.publishAs('bob', { ...SEED, 'new-dashboard': { type: 'boolean', enabled: false } });
    expect(env.currentVersion).toBe(2);

    const dialog = await reopenReview(page);
    await expect(dialog.getByText('This environment has moved on since version 1')).toBeVisible();

    const versionBefore = env.currentVersion;
    await dialog.getByRole('button', { name: 'Discard' }).click();

    await expect(page.getByText('Discarded your pending changes.')).toBeVisible();
    await expect(page.getByRole('button', { name: REVIEW })).toHaveCount(0);
    expect(env.currentVersion).toBe(versionBefore);
    expect(env.features()).toMatchObject({ 'dark-mode': { type: 'boolean', enabled: false } });
  });
});
