import type { Backend } from '../types'
import { createLocalBackend } from './backend.shared.js'

export const backend = createLocalBackend({
    storage: localStorage,
    randomUUID: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
}) as Backend
