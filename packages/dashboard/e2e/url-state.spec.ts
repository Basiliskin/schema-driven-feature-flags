import { expect, test } from './support/fixtures.js';

// A write POST re-renders the page in place, and the filter the operator had applied comes back with it.
// Clicking a flag's name opens its editor in the shared overlay rather than expanding the row in place.
// Saving the main edit form stages the edit rather than publishing it.
// The ROLLBACK form's state echo cannot be proven here: openWriter().rollback is a rejecting stub in this
// in-memory fixture, so that route is covered at request level in test/infrastructure/state-echo.test.ts.
test.describe('URL state across a write', () => {
  test('edits a flag through the shared dialog and keeps the filter after the write', async ({ page, env, openEnvironment }) => {
    await openEnvironment();

    await page.getByRole('searchbox', { name: /Filter flags/ }).fill('checkout');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page.locator('[data-flag]')).toHaveCount(1);

    const row = page.locator('[data-flag="checkout-limits"]');
    await row.getByRole('link', { name: 'checkout-limits' }).click();
    const dialog = page.getByRole('dialog', { name: 'checkout-limits' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Enabled').check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText('Staged. Review your pending changes and choose Update to publish them.')).toBeVisible();
    expect(env.currentVersion).toBe(1);
    await expect(page.getByRole('dialog', { name: 'Review pending changes' }).locator('.flag-key', { hasText: 'checkout-limits' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: /Filter flags/ })).toHaveValue('checkout');
    await expect(page.locator('[data-flag]')).toHaveCount(1);
  });
});
