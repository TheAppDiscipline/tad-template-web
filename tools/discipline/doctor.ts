import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import { resolveProjectRoot, readDisciplineConfig } from './lib/discipline-config.js';

interface Finding {
  status: 'ok' | 'warning' | 'error';
  probable_cause: string;
  next_action: string;
  files_to_check: string[];
}

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relPath));
}

function readIfExists(relPath: string): string {
  const fullPath = path.join(projectRoot, relPath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
}

function countMarkdown(relDir: string): number {
  const fullPath = path.join(projectRoot, relDir);
  if (!fs.existsSync(fullPath)) return 0;
  return fs.readdirSync(fullPath).filter(name => name.endsWith('.md')).length;
}

function diagnoseLog(logPath?: string): Finding[] {
  if (!logPath) return [];
  const resolved = path.resolve(logPath);
  if (!fs.existsSync(resolved)) {
    return [{
      status: 'warning',
      probable_cause: `Gate log not found: ${resolved}`,
      next_action: 'Pass a valid --gate-log path or omit the flag.',
      files_to_check: [resolved],
    }];
  }
  const log = fs.readFileSync(resolved, 'utf8');
  const findings: Finding[] = [];
  if (/discipline:validate\s+--launch|discipline:validate\s+--prod/.test(log)) {
    findings.push({
      status: 'error',
      probable_cause: 'Old Gate D/E command syntax is being used.',
      next_action: 'Use npm run discipline:validate:launch or npm run discipline:validate:prod.',
      files_to_check: ['package.json', resolved],
    });
  }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(log)) {
    findings.push({
      status: 'error',
      probable_cause: 'A tooling dependency or generated file is missing.',
      next_action: 'Run npm install, then npm run discipline:hydrate, then rerun the failing command.',
      files_to_check: ['package.json', 'tools/discipline'],
    });
  }
  if (/Anchor faltante|anchor/i.test(log)) {
    findings.push({
      status: 'warning',
      probable_cause: 'A Discipline file is missing a required section anchor.',
      next_action: 'Restore the expected heading or rerun npm run discipline:hydrate in a clean branch.',
      files_to_check: ['discipline.md', 'task_plan.md', 'findings.md', 'progress.md'],
    });
  }
  return findings;
}

function diagnose(): Finding[] {
  const findings: Finding[] = [];
  for (const relDir of ['.discipline/packets', '.discipline/patches/pending', '.discipline/patches/applied', '.discipline/paste-ready']) {
    if (!exists(relDir)) {
      findings.push({
        status: 'error',
        probable_cause: `Missing Discipline directory: ${relDir}`,
        next_action: 'Run npm run discipline:hydrate.',
        files_to_check: [relDir],
      });
    }
  }

  const pendingPatches = countMarkdown('.discipline/patches/pending');
  if (pendingPatches > 0) {
    findings.push({
      status: 'warning',
      probable_cause: `${pendingPatches} pending patch block(s).`,
      next_action: 'Run npm run discipline:patch:dry-run, then npm run discipline:patch if the diff is expected.',
      files_to_check: ['.discipline/patches/pending'],
    });
  }

  const progress = readIfExists('progress.md');
  if (progress) {
    const lines = progress.split('\n').length;
    if (lines > 150) {
      findings.push({
        status: 'warning',
        probable_cause: `progress.md is long (${lines} lines).`,
        next_action: 'Archive older slices to progress_archive.md and keep only active work in progress.md.',
        files_to_check: ['progress.md', 'progress_archive.md'],
      });
    }
    // Parity with discipline:validate (NN #8 Context Management): also flag too
    // many tracked slices, since 11 short slices can stay under the 150-line cap.
    const sliceCount = (progress.match(/^#{2,4}\s+Slice\s+\d+/gim) || []).length;
    if (sliceCount > 10) {
      findings.push({
        status: 'warning',
        probable_cause: `progress.md tracks ${sliceCount} slices (> 10).`,
        next_action: 'Archive older slices to progress_archive.md; keep the fixed header + last 3 slices + open errors.',
        files_to_check: ['progress.md', 'progress_archive.md'],
      });
    }
  }

  try {
    const config = readDisciplineConfig(projectRoot);
    if ((config.profile === 'LAUNCH' || config.profile === 'PROD') && !exists('.discipline/scorecard.yaml')) {
      findings.push({
        status: 'error',
        probable_cause: `PROFILE=${config.profile} requires scorecard validation.`,
        next_action: `Copy .discipline/scorecard.template.yaml to .discipline/scorecard.yaml, fill it in, and run npm run discipline:validate:${config.profile === 'PROD' ? 'prod' : 'launch'}.`,
        files_to_check: ['discipline.md', '.discipline/scorecard.yaml'],
      });
    }
  } catch (err) {
    findings.push({
      status: 'error',
      probable_cause: (err as Error).message,
      next_action: 'Run npm run discipline:hydrate and check discipline.md.',
      files_to_check: ['discipline.md'],
    });
  }

  findings.push(...diagnoseLog(args['gate-log'] as string | undefined));

  if (findings.length === 0) {
    findings.push({
      status: 'ok',
      probable_cause: 'No common Discipline Loop problems detected.',
      next_action: 'Run npm run discipline:validate, then continue with the current slice.',
      files_to_check: ['discipline.md', 'progress.md'],
    });
  }
  return findings;
}

const findings = diagnose();
if (args.json) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  console.log('\n=== Discipline Doctor ===\n');
  for (const finding of findings) {
    console.log(`[${finding.status.toUpperCase()}] ${finding.probable_cause}`);
    console.log(`  next_action: ${finding.next_action}`);
    console.log(`  files_to_check: ${finding.files_to_check.join(', ')}\n`);
  }
}

if (findings.some(finding => finding.status === 'error')) process.exit(1);
