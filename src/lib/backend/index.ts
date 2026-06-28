import { BACKEND_PROVIDER } from '../../config/runtime'
import type { Backend } from './types'

export async function getBackend(): Promise<Backend> {
    switch (BACKEND_PROVIDER) {
        case 'SUPABASE': {
            const mod = await import('./supabase/backend')
            return mod.backend
        }
        case 'FIREBASE': {
            const mod = await import('./firebase/backend')
            return mod.backend
        }
        case 'LOCAL_ONLY': {
            const mod = await import('./local/backend')
            return mod.backend
        }
        default:
            throw new Error(`Unknown VITE_BACKEND_PROVIDER: ${BACKEND_PROVIDER}`)
    }
}
