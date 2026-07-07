import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import minimist from 'minimist';
import { resolveProjectRoot, readDisciplineConfig } from './lib/discipline-config.js';
import { PROVIDER_MATRIX } from './lib/providers/types.js';

interface Finding {
  status: 'ok' | 'warning' | 'error';
  probable_cause: string;
  next_action: string;
  files_to_check: string[];
}

/**
 * Informational preflight for the automation setup: node/git, agent CLIs on
 * PATH, OneDrive placement, long-path risk, and Windows helpers. This section
 * is ADVISORY: it reports ok / info / warn lines with remediation text and NEVER
 * produces a failing exit code by itself. Run it with `discipline:doctor --providers`.
 */
interface ProviderFinding {
  name: string;
  level: 'ok' | 'info' | 'warn';
  detail: string;
  remedy?: string;
}

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);

/** Run `<cli> --version` with a shell (needed for .cmd shims on win32) and catch everything. */
function probeCliVersion(cli: string): { found: boolean; version?: string } {
  try {
    const proc = spawnSync(`${cli} --version`, { shell: true, encoding: 'utf-8', timeout: 8000, stdio: 'pipe' });
    if (proc.error || (proc.status !== 0 && !proc.stdout)) return { found: false };
    const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim();
    if (!out) return { found: false };
    return { found: true, version: out.split(/\r?\n/)[0].trim() };
  } catch {
    return { found: false };
  }
}

function checkProviders(root: string): ProviderFinding[] {
  const findings: ProviderFinding[] = [];

  // Node version (informational; the gate already enforces engines >=22).
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  findings.push({
    name: 'node',
    level: nodeMajor >= 22 ? 'ok' : 'warn',
    detail: `Node ${process.versions.node}`,
    remedy: nodeMajor >= 22 ? undefined : 'This project requires Node >=22. Install a newer Node.',
  });

  // Git on PATH.
  const git = probeCliVersion('git');
  findings.push({
    name: 'git',
    level: git.found ? 'ok' : 'warn',
    detail: git.found ? (git.version ?? 'found') : 'not found on PATH',
    remedy: git.found ? undefined : 'Install Git and ensure it is on PATH.',
  });

  // Agent CLIs. Absence is informational, not a failure: this is a template and
  // the buyer may drive only one agent family. When found, we append the adapter
  // matrix's tested version range (volatile free text) so the buyer can compare
  // the installed CLI against the range these adapters were written for.
  const matrixByCli = Object.fromEntries(Object.values(PROVIDER_MATRIX).map((m) => [m.cli, m]));
  for (const cli of ['claude', 'codex', 'gemini', 'cursor-agent']) {
    const probe = probeCliVersion(cli);
    const tested = matrixByCli[cli]?.testedRange;
    findings.push({
      name: cli,
      level: 'info',
      detail: probe.found
        ? `${probe.version ?? 'found'}${tested ? ` (adapter tested against: ${tested})` : ''}`
        : 'not found on PATH',
      remedy: probe.found ? undefined : `Optional: install the ${cli} CLI to drive this lane with that agent.`,
    });
  }

  // OneDrive placement: sync conflicts, EBUSY, watcher storms.
  const oneDriveEnv = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean) as string[];
  const underOneDriveEnv = oneDriveEnv.some((base) => root.toLowerCase().startsWith(base.toLowerCase()));
  const nameHasOneDrive = /onedrive/i.test(root);
  if (underOneDriveEnv || nameHasOneDrive) {
    findings.push({
      name: 'onedrive',
      level: 'warn',
      detail: `Repo path looks like it is inside OneDrive: ${root}`,
      remedy: 'OneDrive can cause sync conflicts, EBUSY errors, and file-watcher storms. Move the project outside OneDrive (e.g. C:\\dev\\).',
    });
  } else {
    findings.push({ name: 'onedrive', level: 'ok', detail: 'Repo path is not inside OneDrive.' });
  }

  // Long path risk on Windows.
  if (process.platform === 'win32') {
    const abs = path.resolve(root);
    if (abs.length > 180) {
      findings.push({
        name: 'long-path',
        level: 'warn',
        detail: `Absolute repo path is ${abs.length} chars (> 180).`,
        remedy: 'Long paths risk MAX_PATH errors on Windows. Move the project closer to the drive root or enable long paths.',
      });
    } else {
      findings.push({ name: 'long-path', level: 'ok', detail: `Absolute repo path is ${abs.length} chars.` });
    }

    // Windows helpers (informational). Probe powershell.exe directly (no shell
    // variable expansion, which the surrounding shell would eat first).
    const psProbe = (() => {
      try {
        const proc = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
          encoding: 'utf-8',
          timeout: 8000,
          stdio: 'pipe',
        });
        if (proc.error || proc.status !== 0) return { found: false as const };
        const version = (proc.stdout ?? '').trim().split(/\r?\n/)[0].trim();
        return { found: true as const, version: version || 'ok' };
      } catch {
        return { found: false as const };
      }
    })();
    findings.push({
      name: 'powershell',
      level: psProbe.found ? 'ok' : 'info',
      detail: psProbe.found ? `powershell.exe available (${psProbe.version})` : 'powershell.exe not detected',
      remedy: psProbe.found ? undefined : 'powershell.exe is used for clipboard integration. It ships with Windows.',
    });
    const bash = probeCliVersion('bash');
    findings.push({
      name: 'bash',
      level: 'info',
      detail: bash.found ? `bash available (${bash.version ?? 'ok'})` : 'bash not detected',
      remedy: bash.found ? undefined : 'Optional: Git for Windows provides bash, handy for POSIX scripts.',
    });
  }

  return findings;
}

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
  if (/Missing anchor|anchor/i.test(log)) {
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

if (args.providers === true) {
  // Advisory preflight: never fails by itself. Exits 0 regardless of warnings.
  const providerFindings = checkProviders(projectRoot);
  if (args.json) {
    console.log(JSON.stringify({ providers: providerFindings }, null, 2));
  } else {
    console.log('\n=== Discipline Doctor: providers & environment (advisory) ===\n');
    for (const finding of providerFindings) {
      console.log(`[${finding.level.toUpperCase()}] ${finding.name}: ${finding.detail}`);
      if (finding.remedy) console.log(`  remedy: ${finding.remedy}`);
    }
    console.log('\n(advisory: informational only, never fails the exit code by itself.)\n');
  }
  process.exit(0);
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
