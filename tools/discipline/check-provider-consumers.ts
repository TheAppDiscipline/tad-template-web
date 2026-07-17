import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';

const DIRECT_PROVIDER_ENV = /\b(?:VITE|EXPO_PUBLIC)_BACKEND_PROVIDER\b/g;
const CODE_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.cjs', '.mjs']);
const ALLOWED = new Set([
  path.join('src', 'config', 'env-check.ts'), // rejects legacy variables; it never selects a provider.
  path.join('tools', 'provider-config.js'), // shared Node-side legacy guard.
  path.join('tools', 'discipline', 'check-provider-consumers.ts'),
]);

function collectFiles(root: string, rel = ''): string[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
    const entryRel = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(root, entryRel));
    else if (CODE_EXTENSIONS.has(path.extname(entry.name))) out.push(entryRel);
  }
  return out;
}

export function findDirectProviderConsumers(projectRoot: string): string[] {
  const candidates = [
    ...collectFiles(projectRoot, 'src'),
    ...collectFiles(projectRoot, 'tools'),
    'vite.config.ts',
    'metro.config.cjs',
  ].filter((rel, index, all) => all.indexOf(rel) === index && fs.existsSync(path.join(projectRoot, rel)));

  const violations: string[] = [];
  for (const rel of candidates) {
    if (ALLOWED.has(rel)) continue;
    const content = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (DIRECT_PROVIDER_ENV.test(lines[index])) violations.push(`${rel}:${index + 1}`);
      DIRECT_PROVIDER_ENV.lastIndex = 0;
    }
  }
  return violations;
}

function main(): void {
  const args = minimist(process.argv.slice(2));
  const projectRoot = path.resolve(args['project-dir'] || process.cwd());
  const violations = findDirectProviderConsumers(projectRoot);
  if (violations.length > 0) {
    console.error('[FAIL] Provider contract has direct environment consumers outside approved adapters:');
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error('Use src/config/provider.generated.json via the runtime/build/tool adapter instead.');
    process.exit(1);
  }
  console.log('[OK] Provider consumers use the generated contract.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
