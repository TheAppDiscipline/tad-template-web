// tools/llm_providers/index.js
import { ensurePackageInstalled } from '../optional_dependency.js'

const PROVIDERS = {
    openai: {
        exportName: 'openaiProvider',
        packageName: 'openai',
        installCommand: 'npm install -D openai',
        loader: () => import('./openai.js'),
    },
    gemini: {
        exportName: 'geminiProvider',
        packageName: '@google/genai',
        installCommand: 'npm install -D @google/genai',
        loader: () => import('./gemini.js'),
    },
    anthropic: {
        exportName: 'anthropicProvider',
        packageName: '@anthropic-ai/sdk',
        installCommand: 'npm install -D @anthropic-ai/sdk',
        loader: () => import('./anthropic.js'),
    },
}

export function normalizeProviderName(providerName) {
    return (providerName ?? process.env.LLM_PROVIDER ?? '').trim().toLowerCase()
}

export function getProviderConfig(providerName) {
    const p = normalizeProviderName(providerName)

    if (!p) {
        throw new Error('Missing provider. Set LLM_PROVIDER=openai|gemini|anthropic or pass --provider=...')
    }

    const config = PROVIDERS[p]
    if (!config) {
        throw new Error(`Unknown provider: ${p}`)
    }

    return { name: p, ...config }
}

export async function getProvider(providerName) {
    const config = getProviderConfig(providerName)

    ensurePackageInstalled({
        packageName: config.packageName,
        context: `LLM provider "${config.name}"`,
        installCommand: config.installCommand,
    })

    const mod = await config.loader()
    return mod[config.exportName]
}
