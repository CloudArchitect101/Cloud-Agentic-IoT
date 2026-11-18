import { test, expect } from '@playwright/test';

// Served from dist/ with no Salesforce org behind it, so nobody is signed in.
test.describe('patient portal', () => {
  test('a signed-out visitor is sent to sign in, and sees no patient data', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\?startUrl=%2F/);
    await expect(page.getByText('Sign in to see your room monitor')).toBeVisible();
    await expect(page.getByText('Room temperature')).toHaveCount(0);
  });

  test('there is no self sign-up: the care team creates accounts', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Your care team sets one up for you.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(0);
  });

  test('not found route shows 404', async ({ page }) => {
    await page.goto('/non-existent-route');
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
  });
});
