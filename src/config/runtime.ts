export type BackendProvider = 'SUPABASE' | 'FIREBASE' | 'LOCAL_ONLY'
export type AuthMode = 'MAGIC_LINK' | 'EMAIL_PASSWORD' | 'BOTH' | 'NONE'
import { DEFAULT_RUNTIME_CONFIG, resolveRuntimeConfig } from './runtime.shared.js'

export const runtimeConfig = resolveRuntimeConfig()

export const BACKEND_PROVIDER = runtimeConfig.BACKEND_PROVIDER as BackendProvider
export const AUTH_MODE = runtimeConfig.AUTH_MODE as AuthMode
export { DEFAULT_RUNTIME_CONFIG, resolveRuntimeConfig }
