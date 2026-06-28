// tools/llm_providers/gemini.js
import { GoogleGenAI } from '@google/genai'
import { extractJson } from './json.js'
import { buildGeminiJsonRequest } from './payloads.js'

function requireEnv(name) {
    const v = process.env[name]
    if (!v) throw new Error(`Missing env var: ${name}`)
    return v
}

export const geminiProvider = {
    name: 'gemini',

    async generateJson({ model, system, input, responseSchema }) {
        const apiKey = requireEnv('GEMINI_API_KEY')
        const ai = new GoogleGenAI({ apiKey })

        if (!model) model = process.env.GEMINI_MODEL
        if (!model) throw new Error('Missing model. Set GEMINI_MODEL to the current registry model for the selected role')

        const result = await ai.models.generateContent({
            model,
            ...buildGeminiJsonRequest({ system, input, responseSchema }),
        })

        const text = result.text
        if (!text) throw new Error('Gemini response has empty text')

        return extractJson(text)
    },
}
