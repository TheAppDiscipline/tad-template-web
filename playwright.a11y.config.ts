import { defineConfig, devices } from '@playwright/test'

// Config dedicado para tests de accesibilidad (tests/a11y/).
// Separado del config principal (que usa testDir ./tests/e2e) para que
// `npm run test:a11y` realmente ejecute estos specs y no sea un falso verde.
// F3-F: el dev server (127.0.0.1:4173) lo maneja tools/run_visual_e2e.mjs, no el webServer
// de Playwright (cuyo teardown se cuelga en Windows).
export default defineConfig({
  testDir: './tests/a11y',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
