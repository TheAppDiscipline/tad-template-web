import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:4173'

test.describe('Post-deploy verification', () => {
  test.setTimeout(30_000)

  test('page loads with 200 status and has a title', async ({ page }) => {
    const response = await page.goto(BASE_URL)

    expect(response).not.toBeNull()
    expect(response!.status()).toBe(200)

    const title = await page.title()
    expect(title).toBeTruthy()
  })

  test('no console errors during page load', async ({ page }) => {
    const consoleErrors: string[] = []

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')

    expect(consoleErrors, `Console errors found:\n${consoleErrors.join('\n')}`).toHaveLength(0)
  })

  test('app shell renders (not just an empty root div)', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('domcontentloaded')

    // The root container should have real children, not be empty
    const rootContent = await page.evaluate(() => {
      const root = document.getElementById('root') || document.querySelector('main') || document.body
      return root.innerHTML.trim()
    })

    expect(rootContent.length).toBeGreaterThan(0)

    // There should be a visible content area (heading, main, or similar)
    const hasContent = await page.locator('main, [role="main"], h1, h2, header, nav').first().isVisible()
      .catch(() => false)
    expect(hasContent, 'Expected to find a main content area (main, heading, header, or nav)').toBe(true)
  })

  test('router handles non-existent routes (no blank page)', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/this-route-does-not-exist-404-check`)

    // Accept: a 404 page, or a redirect to home — both are valid
    expect(response).not.toBeNull()
    const status = response!.status()
    expect([200, 301, 302, 404]).toContain(status)

    // Page should not be blank regardless of status
    const bodyText = await page.locator('body').innerText()
    expect(bodyText.trim().length).toBeGreaterThan(0)
  })

  test('static assets load without 404s', async ({ page }) => {
    const failedAssets: string[] = []

    page.on('response', (response) => {
      const url = response.url()
      const isAsset = /\.(js|css|woff2?|png|jpg|svg|ico)(\?|$)/.test(url)
      if (isAsset && response.status() >= 400) {
        failedAssets.push(`${response.status()} ${url}`)
      }
    })

    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')

    expect(failedAssets, `Assets failed to load:\n${failedAssets.join('\n')}`).toHaveLength(0)
  })
})
