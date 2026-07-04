import { defineConfig, devices } from '@playwright/test'

// Dedicated config for accessibility tests (tests/a11y/).
// Separate from the main config (which uses testDir ./tests/e2e) so that
// `npm run test:a11y` actually runs these specs and is not a false green.
// F3-F: the dev server (127.0.0.1:4173) is managed by tools/run_visual_e2e.mjs, not the webServer
// from Playwright (whose teardown hangs on Windows).
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
