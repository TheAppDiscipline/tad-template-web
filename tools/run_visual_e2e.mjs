// Visual e2e/a11y runner. Manages the Vite dev server lifecycle EXPLICITLY instead of
// letting Playwright's `webServer` do it (F3-F): on Windows, Playwright's webServer teardown
// can hang and never return control, even though the tests pass. Here we start Vite, wait
// for it, run Playwright (configs with NO webServer), then kill the Vite process tree in a
// finally block and force-exit with the aggregated exit code.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const HOST = '127.0.0.1'
const PORT = 4173
const APP_URL = `http://${HOST}:${PORT}`
const isWin = process.platform === 'win32'

// Start Vite directly as a single killable process tree (not via `npm run dev`).
const vite = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', HOST, '--port', String(PORT)],
    { stdio: 'inherit', detached: !isWin }
)

function killViteTree() {
    if (vite.pid == null) return
    try {
        if (isWin) {
            spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
            try {
                process.kill(-vite.pid, 'SIGKILL')
            } catch {
                vite.kill('SIGKILL')
            }
        }
    } catch {
        /* already gone */
    }
}

// Playwright configs to run: the default (tests/e2e) plus the a11y config if this lane ships
// one. Each has had its `webServer` removed; this runner owns the server lifecycle instead.
const runs = ['npx playwright test']
if (existsSync('playwright.a11y.config.ts')) {
    runs.push('npx playwright test --config playwright.a11y.config.ts')
}

let code = 0
try {
    // Wait for the dev server to accept connections (or bail if Vite died).
    let up = false
    for (let i = 0; i < 120; i++) {
        if (vite.exitCode !== null) {
            throw new Error(`Vite exited early (code ${vite.exitCode}); is :${PORT} free?`)
        }
        try {
            const r = await fetch(APP_URL)
            if (r.ok) {
                up = true
                break
            }
        } catch {
            /* not up yet */
        }
        await sleep(500)
    }
    if (!up) throw new Error(`Vite did not become reachable on :${PORT} in time`)

    // Run each Playwright config against the already-running server. First non-zero wins.
    for (const cmd of runs) {
        const res = spawnSync(cmd, { stdio: 'inherit', shell: true })
        if ((res.status ?? 1) !== 0) code = res.status ?? 1
    }
} catch (err) {
    console.error('[run_visual_e2e]', err instanceof Error ? err.message : err)
    code = 1
} finally {
    // Always tear down the Vite tree (the part Playwright's webServer botches on Windows).
    killViteTree()
}

process.exit(code)
