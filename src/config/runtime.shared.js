export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
    BACKEND_PROVIDER: 'SUPABASE',
    AUTH_MODE: 'MAGIC_LINK',
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
