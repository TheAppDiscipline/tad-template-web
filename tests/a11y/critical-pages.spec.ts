import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Tests de accesibilidad runtime (WCAG 2.2 AA), parte de `npm run gate:visual`.
 *
 * Por defecto corre un smoke axe sobre la ruta base `/` (el shell del template),
 * asi que el gate verifica algo real desde el primer dia (no es un falso verde).
 *
 * Para Gate D (Launch):
 *   1. Agrega las rutas de tu app que cualquier usuario externo puede ver a CRITICAL_ROUTES.
 *   2. Encadena `npm run test:a11y` en `gate:strict` si quieres que bloquee con PROFILE>=LAUNCH.
 *
 * Corre con el config dedicado (`playwright.a11y.config.ts`), que arranca el dev
 * server en 127.0.0.1:4173 via webServer y resuelve las rutas contra baseURL.
 */

// Rutas de TU app. Vacio por defecto; el smoke base de `/` siempre corre.
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
  // Smoke base: siempre corre contra el shell del template.
  test('a11y: / (shell base)', async ({ page }) => {
    await page.goto('/');
    await expectNoA11yViolations(page);
  });

  // Rutas de negocio que agregue el comprador.
  for (const route of CRITICAL_ROUTES) {
    test(`a11y: ${route}`, async ({ page }) => {
      await page.goto(route);
      await expectNoA11yViolations(page);
    });
  }
});
