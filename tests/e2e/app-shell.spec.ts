import { test, expect } from '@playwright/test'

test('app shell renders the The App Discipline template and the expected state model', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Start from a Discipline Loop shell, not a demo counter.' })).toBeVisible()
  await expect(page.getByText('Discipline Loop Factory Template')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'The shell already carries the four states Discipline Loop expects.' })).toBeVisible()

  await expect(page.locator('[data-state="loading"]')).toBeVisible()
  await expect(page.locator('[data-state="empty"]')).toBeVisible()
  await expect(page.locator('[data-state="error"]')).toBeVisible()
  await expect(page.locator('[data-state="normal"]')).toBeVisible()
})