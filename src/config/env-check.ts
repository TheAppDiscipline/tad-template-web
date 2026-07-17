/**
 * Discipline Loop env-check — fail-fast on misconfigured env vars.
 *
 * Import this module once at app startup (main.tsx).
 * It throws immediately if required vars are missing or have invalid values,
 * so misconfiguration surfaces as a clear error rather than a silent fallback.
 */

import { resolveRuntimeConfig } from './runtime.shared.js'

const env = import.meta.env

// --- Valid values ---
const VALID_PROVIDERS = ['SUPABASE', 'FIREBASE', 'LOCAL_ONLY']
const VALID_AUTH_MODES = ['MAGIC_LINK', 'EMAIL_PASSWORD', 'BOTH', 'NONE']

// Validate the EFFECTIVE provider (what the app will actually run), not the raw
// env var. Reading the raw value meant an unset VITE_BACKEND_PROVIDER skipped
// every provider-specific check while the runtime still resolved a default, so a
// project with no .env passed env-check and then ran against a backend whose
// required vars were never verified. One resolver, one answer.
const provider = resolveRuntimeConfig(env).BACKEND_PROVIDER

// The raw values still matter for typo reporting: resolveRuntimeConfig silently
// falls back to the default on an invalid value, and a typo must not look like a
// deliberate default.
const rawProvider = (env.VITE_BACKEND_PROVIDER as string | undefined)?.trim().toUpperCase()
const rawAuthMode = (env.VITE_AUTH_MODE as string | undefined)?.trim().toUpperCase()

const errors: string[] = []

// --- Provider must be valid if set ---
if (rawProvider && !VALID_PROVIDERS.includes(rawProvider)) {
    errors.push(
        `VITE_BACKEND_PROVIDER="${env.VITE_BACKEND_PROVIDER}" is not valid. ` +
        `Allowed: ${VALID_PROVIDERS.join(' | ')}`
    )
}

// --- Auth mode must be valid if set ---
if (rawAuthMode && !VALID_AUTH_MODES.includes(rawAuthMode)) {
    errors.push(
        `VITE_AUTH_MODE="${env.VITE_AUTH_MODE}" is not valid. ` +
        `Allowed: ${VALID_AUTH_MODES.join(' | ')}`
    )
}

// --- Provider-specific required vars ---
if (provider === 'SUPABASE') {
    if (!env.VITE_SUPABASE_URL) errors.push('VITE_SUPABASE_URL is required when VITE_BACKEND_PROVIDER=SUPABASE')
    if (!env.VITE_SUPABASE_ANON_KEY) errors.push('VITE_SUPABASE_ANON_KEY is required when VITE_BACKEND_PROVIDER=SUPABASE')
}

if (provider === 'FIREBASE') {
    const required = [
        'VITE_FIREBASE_API_KEY',
        'VITE_FIREBASE_AUTH_DOMAIN',
        'VITE_FIREBASE_PROJECT_ID',
        'VITE_FIREBASE_APP_ID',
    ] as const
    for (const key of required) {
        if (!env[key]) errors.push(`${key} is required when VITE_BACKEND_PROVIDER=FIREBASE`)
    }
}

// --- Fail fast ---
if (errors.length > 0) {
    const message = [
        '[Discipline Loop] env-check failed — fix before continuing:',
        ...errors.map(e => `  • ${e}`),
    ].join('\n')
    throw new Error(message)
}
