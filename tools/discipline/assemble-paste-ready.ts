import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineError, disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { STEP_ASSEMBLY_MAP, VALID_STEPS } from './lib/artifact-flow.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const step = args.step?.toString();
const useClipboard = args.clipboard === true;
const openUrl = args.open === true;

export async function assemblePasteReady(root: string, stepId: string): Promise<string> {
  const config = STEP_ASSEMBLY_MAP[stepId];
  if (!config) disciplineError(`Paso "${stepId}" no es válido. Válidos: ${VALID_STEPS.join(', ')}`);

  const packetsDir = path.join(root, '.discipline', 'packets');
  const pasteReadyDir = path.join(root, '.discipline', 'paste-ready');
  const promptsDir = path.join(root, '.discipline', 'prompts');
  if (!fs.existsSync(pasteReadyDir)) fs.mkdirSync(pasteReadyDir, { recursive: true });

  const sections: string[] = [];
  const missing: string[] = [];

  for (const p of config.requiredPackets) {
    const pp = path.join(packetsDir, p);
    if (!fs.existsSync(pp)) missing.push(p);
    else sections.push(`### ${p.replace('.md', '')}\n\n${fs.readFileSync(pp, 'utf-8')}`);
  }
  if (missing.length > 0) disciplineError(`Packets requeridos faltantes para Paso ${stepId}:\n  ${missing.join('\n  ')}`);

  for (const p of config.optionalPackets) {
    const pp = path.join(packetsDir, p);
    if (fs.existsSync(pp)) sections.push(`### ${p.replace('.md', '')} (opcional)\n\n${fs.readFileSync(pp, 'utf-8')}`);
  }

  if (config.includeProjectFiles) {
    for (const f of config.includeProjectFiles) {
      const fp = path.join(root, f);
      if (fs.existsSync(fp)) sections.push(`### ${f} (contexto)\n\n${fs.readFileSync(fp, 'utf-8')}`);
    }
  }

  const promptPath = path.join(promptsDir, `paso-${stepId}-prompt.md`);
  const promptContent = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : `<!-- PROMPT: pegar el prompt del Paso ${stepId} desde el vault (nota 40) -->`;

  const date = new Date().toISOString().slice(0, 10);
  const assembled = `# Bloque Pegable — Paso ${stepId}\n\nSTATUS: listo\nGENERADO_POR: discipline:assemble\nFECHA: ${date}\n\n---\n\n${promptContent}\n\n---\n\n## INPUTS PEGADOS\n\n${sections.join('\n\n---\n\n')}\n`;

  fs.writeFileSync(path.join(pasteReadyDir, config.outputFile), assembled, 'utf-8');
  disciplineInfo(`Ensamblado: .discipline/paste-ready/${config.outputFile}`);
  return assembled;
}

// Solo ejecutar como CLI cuando se invoca directamente (npm run discipline:assemble).
// Cuando se importa desde otro modulo (ej: watch.ts), no auto-ejecutar.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!step) disciplineError(`Falta --step. Uso: discipline:assemble --step <${VALID_STEPS.join('|')}>`);
  assemblePasteReady(projectRoot, step!).then(assembled => {
    if (useClipboard) {
      try {
        if (process.platform === 'win32') execSync('clip', { input: assembled });
        else execSync('pbcopy', { input: assembled });
        disciplineInfo('Copiado al clipboard.');
      } catch { disciplineWarn('No se pudo copiar al clipboard.'); }
    }
    if (openUrl) {
      const config = STEP_ASSEMBLY_MAP[step!];
      if (config?.toolUrl) {
        try {
          const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          execSync(`${cmd} ${config.toolUrl}`);
        } catch { disciplineWarn(`No se pudo abrir: ${config.toolUrl}`); }
      }
    }
  }).catch(e => disciplineError(e.message));
}
