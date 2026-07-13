import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const qwenProvider = createOpenAiCompatibleProvider({
    name: 'qwen',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    modelEnv: 'QWEN_MODEL',
    baseUrlEnv: 'QWEN_BASE_URL',
    defaultBaseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    structuredOutput: 'json_object',
})
