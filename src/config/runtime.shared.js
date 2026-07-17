// Zero-config default: a fresh clone with no .env runs LOCAL_ONLY and works.
// It used to default to SUPABASE, which meant no-.env resolved to a provider
// whose credentials could not possibly be set yet: the app claimed a backend it
// did not have. Pick a backend by setting VITE_BACKEND_PROVIDER; env-check then
// enforces that provider's required vars.
export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
    BACKEND_PROVIDER: 'LOCAL_ONLY',
    AUTH_MODE: 'NONE',
})

const VALID_BACKEND_PROVIDERS = new Set(['SUPABASE', 'FIREBASE', 'LOCAL_ONLY'])
const VALID_AUTH_MODES = new Set(['MAGIC_LINK', 'EMAIL_PASSWORD', 'BOTH', 'NONE'])

function normalizeEnumValue(value) {
    return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

export function resolveRuntimeConfig(env = {}) {
    const backendProvider = normalizeEnumValue(env.VITE_BACKEND_PROVIDER)
    const authMode = normalizeEnumValue(env.VITE_AUTH_MODE)

    return {
        BACKEND_PROVIDER: VALID_BACKEND_PROVIDERS.has(backendProvider)
            ? backendProvider
            : DEFAULT_RUNTIME_CONFIG.BACKEND_PROVIDER,
        AUTH_MODE: VALID_AUTH_MODES.has(authMode)
            ? authMode
            : DEFAULT_RUNTIME_CONFIG.AUTH_MODE,
    }
}
