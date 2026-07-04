import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineInfo } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';

export async function logRun(root: string, entry: { step: string; tool: string; inputPacket?: string; outputPacket?: string; notes?: string }): Promise<void> {
  const logPath = path.join(root, '.discipline', 'run-log.md');
  if (!entry.step) disciplineError('Missing --step');
  if (!entry.tool) disciplineError('Missing --tool');

  if (!fs.existsSync(logPath)) {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(logPath, `# Run Log\n\n| Date | Step | Tool | Input | Output | Notes |\n|---|---|---|---|---|---|\n`, 'utf-8');
  }

  const now = new Date();
  const date = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`;
  fs.appendFileSync(logPath, `| ${date} | Step ${entry.step} | ${entry.tool} | ${entry.inputPacket || '-'} | ${entry.outputPacket || '-'} | ${entry.notes || 'OK'} |\n`, 'utf-8');
  disciplineInfo(`Run logged: Step ${entry.step} with ${entry.tool}`);
}

// Only execute as CLI when invoked directly (npm run discipline:log).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2));
  const projectRoot = resolveProjectRoot(args['project-dir']);
  logRun(projectRoot, { step: args.step?.toString() || '', tool: args.tool || '', inputPacket: args['input-packet'], outputPacket: args['output-packet'], notes: args.notes }).catch(e => disciplineError(e.message));
}
