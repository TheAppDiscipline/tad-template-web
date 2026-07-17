import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';

export const PROVIDER_CONFIG_SCHEMA = 'discipline.provider-config/v1';
export const PROVIDER_ARTIFACT_REL = path.join('src', 'config', 'provider.generated.json');
export const PROVIDER_RUNTIME_ARTIFACT_REL = path.join('src', 'config', 'provider.generated.js');

export type BackendProvider = 'SUPABASE' | 'FIREBASE' | 'LOCAL_ONLY';
export type AuthMode = 'MAGIC_LINK' | 'EMAIL_PASSWORD' | 'BOTH' | 'NONE';

export interface ProviderConfig {
  schema: typeof PROVIDER_CONFIG_SCHEMA;
  backendProvider: BackendProvider;
  authMode: AuthMode;
}

const BACKENDS = new Set<BackendProvider>(['SUPABASE', 'FIREBASE', 'LOCAL_ONLY']);
const AUTH_MODES = new Set<AuthMode>(['MAGIC_LINK', 'EMAIL_PASSWORD', 'BOTH', 'NONE']);

function readSwitch(content: string, key: string): string {
  const match = content.match(new RegExp(`^-\\s*${key}:\\s*([^#\\r\\n]*)`, 'mi'));
  return match?.[1]?.trim() ?? '';
}

function resolveEnum<T extends string>(raw: string, allowed: Set<T>, fallback: T, label: string): T {
  if (!raw) return fallback;
  const value = raw.toUpperCase() as T;
  if (allowed.has(value)) return value;
  throw new Error(`${label} in discipline.md must be one of ${[...allowed].join(', ')}; got "${raw}".`);
}

export function providerConfigFromDiscipline(content: string): ProviderConfig {
  return {
    schema: PROVIDER_CONFIG_SCHEMA,
    backendProvider: resolveEnum(readSwitch(content, 'BACKEND_PROVIDER'), BACKENDS, 'LOCAL_ONLY', 'BACKEND_PROVIDER'),
    authMode: resolveEnum(readSwitch(content, 'AUTH_MODE'), AUTH_MODES, 'NONE', 'AUTH_MODE'),
  };
}

export function renderProviderConfig(config: ProviderConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function renderRuntimeProviderConfig(config: ProviderConfig): string {
  return `// Generated from discipline.md. Do not edit by hand.\nconst providerConfig = Object.freeze(${JSON.stringify(config, null, 2)});\n\nexport default providerConfig;\n`;
}

export function artifactPath(projectRoot: string): string {
  return path.join(projectRoot, PROVIDER_ARTIFACT_REL);
}

export function runtimeArtifactPath(projectRoot: string): string {
  return path.join(projectRoot, PROVIDER_RUNTIME_ARTIFACT_REL);
}

export function generateProviderConfig(projectRoot: string): ProviderConfig {
  const disciplinePath = path.join(projectRoot, 'discipline.md');
  if (!fs.existsSync(disciplinePath)) throw new Error(`discipline.md not found in: ${projectRoot}`);

  const config = providerConfigFromDiscipline(fs.readFileSync(disciplinePath, 'utf8'));
  const target = artifactPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderProviderConfig(config), 'utf8');
  fs.writeFileSync(runtimeArtifactPath(projectRoot), renderRuntimeProviderConfig(config), 'utf8');
  return config;
}

export function verifyProviderConfig(projectRoot: string): { ok: boolean; message: string } {
  const disciplinePath = path.join(projectRoot, 'discipline.md');
  if (!fs.existsSync(disciplinePath)) return { ok: false, message: `discipline.md not found in: ${projectRoot}` };

  const expected = renderProviderConfig(providerConfigFromDiscipline(fs.readFileSync(disciplinePath, 'utf8')));
  const expectedRuntime = renderRuntimeProviderConfig(providerConfigFromDiscipline(fs.readFileSync(disciplinePath, 'utf8')));
  const target = artifactPath(projectRoot);
  if (!fs.existsSync(target)) {
    return { ok: false, message: `${PROVIDER_ARTIFACT_REL} is missing. Run npm run discipline:provider:generate.` };
  }
  const actual = fs.readFileSync(target, 'utf8');
  if (actual !== expected) {
    return { ok: false, message: `${PROVIDER_ARTIFACT_REL} is stale. Run npm run discipline:provider:generate and commit it.` };
  }
  const runtimeTarget = runtimeArtifactPath(projectRoot);
  if (!fs.existsSync(runtimeTarget) || fs.readFileSync(runtimeTarget, 'utf8') !== expectedRuntime) {
    return { ok: false, message: `${PROVIDER_RUNTIME_ARTIFACT_REL} is missing or stale. Run npm run discipline:provider:generate and commit it.` };
  }
  return { ok: true, message: `${PROVIDER_ARTIFACT_REL} matches discipline.md.` };
}

function main(): void {
  const args = minimist(process.argv.slice(2));
  const projectRoot = path.resolve(args['project-dir'] || process.cwd());
  if (args.check) {
    const result = verifyProviderConfig(projectRoot);
    (result.ok ? console.log : console.error)(`provider-config: ${result.ok ? '[OK]' : '[FAIL]'} ${result.message}`);
    process.exit(result.ok ? 0 : 1);
  }
  try {
    const config = generateProviderConfig(projectRoot);
    console.log(`provider-config: wrote ${PROVIDER_ARTIFACT_REL} (${config.backendProvider} / ${config.authMode}).`);
  } catch (error) {
    console.error(`provider-config: [FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
