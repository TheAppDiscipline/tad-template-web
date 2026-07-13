import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const ollamaProvider = createOpenAiCompatibleProvider({
    name: 'ollama',
    apiKeyEnv: 'OLLAMA_API_KEY',
    modelEnv: 'OLLAMA_MODEL',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyRequired: false,
    structuredOutput: 'prompt',
})
