import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const grokProvider = createOpenAiCompatibleProvider({
    name: 'grok',
    apiKeyEnv: 'XAI_API_KEY',
    modelEnv: 'GROK_MODEL',
    baseUrlEnv: 'GROK_BASE_URL',
    defaultBaseUrl: 'https://api.x.ai/v1',
    structuredOutput: 'json_schema',
    strictSchema: true,
})
