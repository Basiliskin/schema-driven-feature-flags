import { expect, test } from './support/fixtures.js';

// A write POST re-renders the page in place, and the row the operator had open — plus the filter they had
// applied — come back with it. Saving the main edit form stages the edit rather than publishing it.
// The ROLLBACK form's state echo cannot be proven here: openWriter().rollback is a rejecting stub in this
// in-memory fixture, so that route is covered at request level in test/infrastructure/state-echo.test.ts.
test.describe('URL state across a write', () => {
  test('keeps the open flag row and the filter after an edit is staged', async ({ page, env, openEnvironment }) => {
    await openEnvironment();

    const row = page.locator('[data-flag="checkout-limits"]');
    await row.getByRole('link', { name: 'Expand' }).click();
    await expect(row.locator('.flag-row')).toHaveAttribute('open', '');

    await page.getByRole('searchbox', { name: /Filter flags/ }).fill('checkout');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page.locator('[data-flag]')).toHaveCount(1);

    await row.getByLabel('Enabled').check();
    await row.getByRole('button', { name: 'Save enabled' }).click();

    await expect(page.getByText('Staged. Review your pending changes and choose Update to publish them.')).toBeVisible();
    expect(env.currentVersion).toBe(1);
    await expect(page.getByRole('dialog', { name: 'Review pending changes' }).locator('.flag-key', { hasText: 'checkout-limits' })).toBeVisible();
    await expect(row.locator('.flag-row')).toHaveAttribute('open', '');
    await expect(page.getByRole('searchbox', { name: /Filter flags/ })).toHaveValue('checkout');
    await expect(page.locator('[data-flag]')).toHaveCount(1);
  });
});
