import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  // F3-F: the dev server lifecycle is managed by tools/run_visual_e2e.mjs (npm run
  // gate:visual), NOT by Playwright's `webServer`, whose teardown can hang on Windows.
  // To run a single config against an already-running dev server, start `npm run dev --
  // --port 4173` yourself, then `npm run e2e`.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})