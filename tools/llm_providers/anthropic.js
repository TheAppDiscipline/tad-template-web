// tools/llm_providers/anthropic.js
import Anthropic from '@anthropic-ai/sdk'
import { extractJson } from './json.js'
import { ANTHROPIC_JSON_TOOL_NAME, buildAnthropicJsonRequest } from './payloads.js'

function requireEnv(name) {
    const v = process.env[name]
    if (!v) throw new Error(`Missing env var: ${name}`)
    return v
}

function extractTextFromClaudeMessage(msg) {
    if (!msg?.content || !Array.isArray(msg.content)) return ''
    return msg.content.map(b => (b && b.type === 'text' ? b.text : '')).join('')
}

function extractToolInputFromClaudeMessage(msg) {
    if (!msg?.content || !Array.isArray(msg.content)) return null
    const block = msg.content.find(b => b && b.type === 'tool_use' && b.name === ANTHROPIC_JSON_TOOL_NAME)
    return block?.input ?? null
}

export const anthropicProvider = {
    name: 'anthropic',

    async generateJson({ model, system, input, responseSchema }) {
        requireEnv('ANTHROPIC_API_KEY')
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

        if (!model) model = process.env.ANTHROPIC_MODEL
        if (!model) throw new Error('Missing model. Set ANTHROPIC_MODEL to the current registry model for the selected role')

        const msg = await client.messages.create(buildAnthropicJsonRequest({
            model,
            maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 2048),
            system,
            input,
            responseSchema,
        }))

        const toolInput = extractToolInputFromClaudeMessage(msg)
        if (toolInput) return toolInput

        const text = extractTextFromClaudeMessage(msg).trim()
        if (!text) throw new Error('Anthropic response has empty text')

        return extractJson(text)
    },
}
