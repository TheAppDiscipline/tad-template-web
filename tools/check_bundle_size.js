/**
 * Bundle Size Gate
 * Discipline Loop non-negotiable #20: entry bundle must be < 200 KB gzipped per chunk,
 * AND total JS must be < 400 KB gzipped cumulative.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const PER_CHUNK_LIMIT = 200 * 1024  // 200 KB per chunk
const CUMULATIVE_LIMIT = 400 * 1024 // 400 KB total JS
const DIST_ASSETS = path.join(process.cwd(), 'dist', 'assets')

console.log('--- Bundle Size Gate ---')

try {
    execSync('npm run build', { stdio: 'pipe' })
} catch (err) {
    console.error('[FAIL] Build failed — cannot check bundle size.')
    console.error(err.stderr?.toString() ?? err.message)
    process.exit(1)
}

const files = fs.readdirSync(DIST_ASSETS).filter(f => f.endsWith('.js'))

if (files.length === 0) {
    console.error('[FAIL] No JS files found in dist/assets.')
    process.exit(1)
}

let failed = false
let totalGzipped = 0

for (const file of files) {
    const filePath = path.join(DIST_ASSETS, file)
    const raw = fs.readFileSync(filePath)
    const gzipped = zlib.gzipSync(raw)
    const kb = (gzipped.length / 1024).toFixed(1)
    const over = gzipped.length > PER_CHUNK_LIMIT

    totalGzipped += gzipped.length

    const status = over ? '[FAIL]' : '[PASS]'
    console.log(`${status} ${file}: ${kb} KB gzipped (limit: ${(PER_CHUNK_LIMIT/1024).toFixed(0)} KB)`)

    if (over) failed = true
}

// Cumulative check
const totalKb = (totalGzipped / 1024).toFixed(1)
const cumulativeOver = totalGzipped > CUMULATIVE_LIMIT
const cumulativeStatus = cumulativeOver ? '[FAIL]' : '[PASS]'
console.log(`\n${cumulativeStatus} Total JS: ${totalKb} KB gzipped (limit: ${(CUMULATIVE_LIMIT/1024).toFixed(0)} KB)`)

if (cumulativeOver) failed = true

if (failed) {
    console.error('\nBundle exceeds size limits.')
    console.error('Options: lazy-load routes, trim unused deps, check for accidental full-library imports.')
    process.exit(1)
} else {
    console.log('\n[PASS] All chunks and cumulative total within limits.')
}
