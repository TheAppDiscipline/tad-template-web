import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function isPackageInstalled(packageName) {
    try {
        require.resolve(packageName)
        return true
    } catch {
        return false
    }
}

export function formatMissingDependencyMessage({ packageName, context, installCommand }) {
    return `[FAIL] Missing optional dependency for ${context}: ${packageName}. Install it with "${installCommand}" and retry.`
}

export function ensurePackageInstalled({ packageName, context, installCommand }) {
    if (!isPackageInstalled(packageName)) {
        throw new Error(formatMissingDependencyMessage({ packageName, context, installCommand }))
    }
}
