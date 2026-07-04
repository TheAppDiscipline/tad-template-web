import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Runtime accessibility tests (WCAG 2.2 AA), part of `npm run gate:visual`.
 *
 * By default, runs an axe smoke check against the base route `/` (the template shell),
 * so the gate verifies something real from day one (not a false green).
 *
 * For Gate D (Launch):
 *   1. Add the routes of your app that any external user can see to CRITICAL_ROUTES.
 *   2. Chain `npm run test:a11y` into `gate:strict` if you want it to block with PROFILE>=LAUNCH.
 *
 * Runs with the dedicated config (`playwright.a11y.config.ts`), which starts the dev
 * server on 127.0.0.1:4173 via webServer and resolves routes against baseURL.
 */

// Routes for YOUR app. Empty by default; the base smoke check for `/` always runs.
const CRITICAL_ROUTES: string[] = [
  // '/sign-in',
  // '/dashboard',
  // '/settings',
  // '/privacy',
];

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('Accessibility (WCAG 2.2 AA)', () => {
  // Base smoke check: always runs against the template shell.
  test('a11y: / (shell base)', async ({ page }) => {
    await page.goto('/');
    await expectNoA11yViolations(page);
  });

  // Business routes added by the buyer.
  for (const route of CRITICAL_ROUTES) {
    test(`a11y: ${route}`, async ({ page }) => {
      await page.goto(route);
      await expectNoA11yViolations(page);
    });
  }
});
