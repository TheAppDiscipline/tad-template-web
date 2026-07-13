import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const minimaxProvider = createOpenAiCompatibleProvider({
    name: 'minimax',
    apiKeyEnv: 'MINIMAX_API_KEY',
    modelEnv: 'MINIMAX_MODEL',
    baseUrlEnv: 'MINIMAX_BASE_URL',
    defaultBaseUrl: 'https://api.minimax.io/v1',
    structuredOutput: 'prompt',
})
