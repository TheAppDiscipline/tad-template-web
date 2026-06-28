import fs from 'node:fs'
import path from 'node:path'

function readFileIfPresent(filePath) {
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf8')
}

export function readProjectSwitches(root = process.cwd()) {
    const gemini = readFileIfPresent(path.join(root, 'discipline.md'))
    const switches = {}

    for (const key of ['AI_FEATURES', 'BACKEND_PROVIDER', 'AUTH_MODE']) {
        const match = gemini.match(new RegExp(`-\\s+${key}:\\s*([^#\\r\\n]+)`))
        if (match) {
            switches[key] = match[1].trim()
        }
    }

    return switches
}

export function isAiEnabled(root = process.cwd()) {
    return (readProjectSwitches(root).AI_FEATURES ?? 'none').toLowerCase() === 'enabled'
}

export function listConfiguredEvalFeatures(root = process.cwd()) {
    const evalDir = path.join(root, 'evals')
    if (!fs.existsSync(evalDir)) return []

    return fs
        .readdirSync(evalDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name.replace(/\.jsonl$/, ''))
        .sort()
}
