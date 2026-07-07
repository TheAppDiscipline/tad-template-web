/**
 * Provider adapter registry. Maps a provider name (as used by --provider and the
 * `## Autonomy` config) to its ProviderAdapter. The names match PROVIDER_MATRIX.
 */

import type { ProviderAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { cursorAdapter } from './cursor.js';

export const ADAPTERS: Record<string, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  cursor: cursorAdapter,
};

export const PROVIDER_NAMES = Object.keys(ADAPTERS) as Array<keyof typeof ADAPTERS>;

export function getAdapter(name: string): ProviderAdapter | null {
  return ADAPTERS[name] ?? null;
}

export type { ProviderAdapter, AdapterResult, AdapterRole, AdapterStatus, ProviderFamily } from './types.js';
export { PROVIDER_MATRIX, familyOf, detectParkedReason, firstErrorLine } from './types.js';
export { runAdapter, treeKill } from './runner.js';
export type { RunAdapterOptions, RunAdapterOutcome } from './runner.js';
export { CODEX_RESUME_ARGS } from './codex.js';
