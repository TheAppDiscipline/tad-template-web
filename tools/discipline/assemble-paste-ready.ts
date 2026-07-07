import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineError, disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { copyToClipboard } from './lib/clipboard.js';
import { STEP_ASSEMBLY_MAP, VALID_STEPS } from './lib/artifact-flow.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const step = args.step?.toString();
const useClipboard = args.clipboard === true;
const openUrl = args.open === true;

export async function assemblePasteReady(root: string, stepId: string): Promise<string> {
  const config = STEP_ASSEMBLY_MAP[stepId];
  if (!config) disciplineError(`Step "${stepId}" is not valid. Valid steps: ${VALID_STEPS.join(', ')}`);

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
  if (missing.length > 0) disciplineError(`Missing required packets for Step ${stepId}:\n  ${missing.join('\n  ')}`);

  for (const p of config.optionalPackets) {
    const pp = path.join(packetsDir, p);
    if (fs.existsSync(pp)) sections.push(`### ${p.replace('.md', '')} (optional)\n\n${fs.readFileSync(pp, 'utf-8')}`);
  }

  if (config.includeProjectFiles) {
    for (const f of config.includeProjectFiles) {
      const fp = path.join(root, f);
      if (fs.existsSync(fp)) sections.push(`### ${f} (context)\n\n${fs.readFileSync(fp, 'utf-8')}`);
    }
  }

  const promptPath = path.join(promptsDir, `step-${stepId}-prompt.md`);
  const promptContent = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : `<!-- PROMPT: paste the Step ${stepId} prompt from the vault/reference material -->`;

  const date = new Date().toISOString().slice(0, 10);
  const assembled = `# Paste-Ready Block - Step ${stepId}\n\nSTATUS: ready\nGENERATED_BY: discipline:assemble\nDATE: ${date}\n\n---\n\n${promptContent}\n\n---\n\n## PASTED INPUTS\n\n${sections.join('\n\n---\n\n')}\n`;

  fs.writeFileSync(path.join(pasteReadyDir, config.outputFile), assembled, 'utf-8');
  disciplineInfo(`Assembled: .discipline/paste-ready/${config.outputFile}`);
  return assembled;
}

// Only execute as CLI when invoked directly (npm run discipline:assemble).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!step) disciplineError(`Missing --step. Usage: discipline:assemble --step <${VALID_STEPS.join('|')}>`);
  assemblePasteReady(projectRoot, step!).then(assembled => {
    if (useClipboard) {
      try {
        copyToClipboard(assembled);
        disciplineInfo('Copied to clipboard.');
      } catch { disciplineWarn('Could not copy to clipboard.'); }
    }
    if (openUrl) {
      const config = STEP_ASSEMBLY_MAP[step!];
      if (config?.toolUrl) {
        try {
          const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          execSync(`${cmd} ${config.toolUrl}`);
        } catch { disciplineWarn(`Could not open: ${config.toolUrl}`); }
      }
    }
  }).catch(e => disciplineError(e.message));
}
