// tools/llm_providers/json.js
export function extractJson(text) {
    if (typeof text !== 'string') throw new Error('Model output is not a string')

    // 1) Try raw parse
    try {
        return JSON.parse(text)
    } catch { }

    // 2) Strip ```json fences
    const fenced = text
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim()

    try {
        return JSON.parse(fenced)
    } catch { }

    // 3) Best-effort: grab first {...} or [...]
    const firstObj = fenced.indexOf('{')
    const lastObj = fenced.lastIndexOf('}')
    const firstArr = fenced.indexOf('[')
    const lastArr = fenced.lastIndexOf(']')

    const candidates = []

    if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
        candidates.push(fenced.slice(firstObj, lastObj + 1))
    }
    if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
        candidates.push(fenced.slice(firstArr, lastArr + 1))
    }

    for (const c of candidates) {
        try {
            return JSON.parse(c)
        } catch { }
    }

    throw new Error('Could not parse JSON from model output')
}
