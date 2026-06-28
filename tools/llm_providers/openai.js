// tools/llm_providers/openai.js
import OpenAI from 'openai'
import { extractJson } from './json.js'
import { buildOpenAiJsonRequest } from './payloads.js'

function requireEnv(name) {
    const v = process.env[name]
    if (!v) throw new Error(`Missing env var: ${name}`)
    return v
}

export const openaiProvider = {
    name: 'openai',

    async generateJson({ model, system, input, responseSchema }) {
        requireEnv('OPENAI_API_KEY')
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

        if (!model) model = process.env.OPENAI_MODEL
        if (!model) throw new Error('Missing model. Set OPENAI_MODEL (e.g. gpt-4o)')

        const resp = await client.chat.completions.create(buildOpenAiJsonRequest({
            model,
            system,
            input,
            responseSchema,
        }))

        const text = resp.choices[0]?.message?.content ?? ''
        if (!text) throw new Error('OpenAI response has empty content')

        return extractJson(text)
    },
}
