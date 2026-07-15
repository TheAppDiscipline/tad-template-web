import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import type { ValidationIssue } from './lib/types.js';
import { disciplineInfo } from './lib/types.js';
import { resolveProjectRoot, readDisciplineConfig } from './lib/discipline-config.js';
import { DISCIPLINE_MD_ANCHORS, TASK_PLAN_ANCHORS, FINDINGS_ANCHORS, PROGRESS_ANCHORS } from './lib/anchors.js';
import { ALL_PACKET_NAMES } from './lib/artifact-flow.js';
import { parsePacketFile } from './lib/parse-packet.js';
import { parsePacketMeta } from './lib/packet-meta.js';
import { validateScorecard, type ScorecardMode } from './validate-scorecard.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const statusMode = args.status === true;

type SemanticPacketRule = {
  status?: string;
  headings?: string[];
  /** Advisory completeness checks for packets already promoted to ready. */
  readyHeadings?: string[];
};

const SEMANTIC_PACKET_RULES: Record<string, SemanticPacketRule> = {
  'STEP_2_ARCHITECTURE_PACKET': {
    headings: ['Architecture', 'Data model'],
  },
  'STEP_4_EXECUTION_PACKET': {
    status: 'validated',
    headings: ['Product summary', 'Slice'],
  },
  'STEP_5_SLICE_PACKET': {
    headings: ['Goal', 'Scope', 'Contracts', 'Acceptance criteria'],
    readyHeadings: ['Provider Impact', 'AI Impact', 'Files to touch', 'Manual Verification', 'Estimate'],
  },
  'DEPLOY_READINESS_PACKET': {
    headings: ['Platform checks'],
  },
  'POST_DEPLOY_FEEDBACK_PACKET': {
    headings: ['Recommended branch'],
  },
  'PROD_HARDENING_PACKET': {
    headings: ['Target phase', 'Mandatory slices'],
  },
  'SLICE_COMPLETION_PACKET': {
    headings: ['Outcome', 'Scope delivered', 'Gates passed', 'Deploy signal'],
  },
};

export function validateDiscipline(root: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pendingDir = path.join(root, '.discipline', 'patches', 'pending');
  if (fs.existsSync(pendingDir)) {
    const pending = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
    if (pending.length > 0) issues.push({ severity: 'error', message: `${pending.length} pending patch(es)`, detail: 'npm run discipline:patch' });
  }

  checkAnchors(root, 'discipline.md', [...DISCIPLINE_MD_ANCHORS], issues);
  checkAnchors(root, 'task_plan.md', [...TASK_PLAN_ANCHORS], issues);
  checkAnchors(root, 'findings.md', [...FINDINGS_ANCHORS], issues);
  checkAnchors(root, 'progress.md', [...PROGRESS_ANCHORS], issues);

  for (const dir of ['.discipline/packets', '.discipline/patches/pending', '.discipline/patches/applied', '.discipline/paste-ready']) {
    if (!fs.existsSync(path.join(root, dir))) {
      issues.push({ severity: 'error', message: `Missing directory: ${dir}`, detail: 'npm run discipline:hydrate' });
    }
  }

  checkPacketSemantics(root, issues);
  checkPacketFrontmatter(root, issues);
  checkProgressLength(root, issues);
  checkProfileScorecard(root, issues);
  return issues;
}

// Optional packet frontmatter (warn-only). Packets without a `---` block are
// legacy and fine. When frontmatter is present but malformed or fails the
// generic schema, list it as a warning. The human-readable body stays
// canonical, so this NEVER changes the exit code.
function checkPacketFrontmatter(root: string, issues: ValidationIssue[]) {
  const packetsDir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(packetsDir)) return;

  const files = fs.readdirSync(packetsDir).filter(fileName => fileName.endsWith('.md'));
  for (const fileName of files) {
    const content = fs.readFileSync(path.join(packetsDir, fileName), 'utf-8');
    const { errors } = parsePacketMeta(content);
    for (const error of errors) {
      issues.push({
        severity: 'warning',
        file: fileName,
        message: `packet frontmatter: ${error}`,
        detail: 'Optional metadata, advisory only. The markdown body remains canonical.',
      });
    }
  }
}

function checkProfileScorecard(root: string, issues: ValidationIssue[]) {
  let config;
  try {
    config = readDisciplineConfig(root);
  } catch {
    return;
  }

  let mode: ScorecardMode | null = null;
  if (config.profile === 'LAUNCH') mode = 'launch';
  if (config.profile === 'PROD') mode = 'prod';
  if (!mode) return;

  const command = `npm run discipline:validate:${mode}`;
  try {
    const report = validateScorecard(root, mode);
    for (const warning of report.warnings) {
      issues.push({
        severity: 'warning',
        file: '.discipline/scorecard.yaml',
        message: warning,
        detail: command,
      });
    }
    for (const error of report.errors) {
      issues.push({
        severity: 'error',
        file: '.discipline/scorecard.yaml',
        message: error,
        detail: command,
      });
    }
  } catch (err) {
    issues.push({
      severity: 'error',
      file: '.discipline/scorecard.yaml',
      message: (err as Error).message,
      detail: command,
    });
  }
}

// Discipline Loop NN #8 Context Management: progress.md must not exceed 150 lines
// or 10 active slices. If exceeded, the operator should archive to
// progress_archive.md, keeping only the fixed block + last 3 slices + open errors.
function checkProgressLength(root: string, issues: ValidationIssue[]) {
  const fp = path.join(root, 'progress.md');
  if (!fs.existsSync(fp)) return;
  const content = fs.readFileSync(fp, 'utf-8');
  const lineCount = content.split('\n').length;
  const sliceMatches = content.match(/^#{2,4}\s+Slice\s+\d+/gim);
  const sliceCount = sliceMatches ? sliceMatches.length : 0;

  if (lineCount > 150) {
    issues.push({
      severity: 'warning',
      file: 'progress.md',
      message: `progress.md has ${lineCount} lines (> 150). Archive older content to progress_archive.md.`,
      detail: 'Discipline Loop NN #8 Context Management (Anti-Amnesia)',
    });
  }
  if (sliceCount > 10) {
    issues.push({
      severity: 'warning',
      file: 'progress.md',
      message: `progress.md has ${sliceCount} slices tracked (> 10). Archive older slices.`,
      detail: 'Discipline Loop NN #8 Context Management (Anti-Amnesia)',
    });
  }
}

function checkAnchors(root: string, fileName: string, expected: string[], issues: ValidationIssue[]) {
  const fp = path.join(root, fileName);
  if (!fs.existsSync(fp)) {
    issues.push({ severity: 'error', message: `File not found: ${fileName}`, detail: 'npm run discipline:hydrate' });
    return;
  }

  const content = fs.readFileSync(fp, 'utf-8');
  for (const anchor of expected) {
    if (!content.includes(anchor)) {
      issues.push({ severity: 'warning', message: `Missing anchor in ${fileName}: "${anchor}"`, file: fileName });
    }
  }
}

function checkPacketSemantics(root: string, issues: ValidationIssue[]) {
  const packetsDir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(packetsDir)) return;

  const files = fs.readdirSync(packetsDir).filter(fileName => fileName.endsWith('.md'));
  for (const fileName of files) {
    if (fileName.includes('.draft.') || fileName.includes('.superseded.')) continue;

    const filePath = path.join(packetsDir, fileName);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const parsed = parsePacketFile(filePath, fileContent);
    const packetName = normalizePacketName(parsed.name || fileName);
    const rules = SEMANTIC_PACKET_RULES[packetName];

    if (!rules) continue;

    if (!hasReadablePacketStart(fileContent)) {
      issues.push({
        severity: 'error',
        file: fileName,
        message: `${packetName} must start with "# ${packetName}" or YAML frontmatter; put STATUS after the heading/frontmatter.`,
      });
    }

    if (rules.status && parsed.status !== rules.status) {
      issues.push({
        severity: 'error',
        file: fileName,
        message: `${packetName} must have STATUS: ${rules.status}`,
      });
    }

    for (const heading of rules.headings ?? []) {
      if (!hasPacketHeading(parsed.body, heading)) {
        issues.push({
          severity: 'error',
          file: fileName,
          message: `${packetName} incomplete: missing ${heading}`,
        });
      }
    }

    if (parsed.status === 'ready') {
      for (const heading of rules.readyHeadings ?? []) {
        if (!hasPacketHeading(parsed.body, heading)) {
          issues.push({
            severity: 'warning',
            file: fileName,
            message: `${packetName} ready packet advisory: missing ${heading}`,
            detail: 'Add the implementation-planning section before handing the slice to Step 5.',
          });
        }
      }
    }
  }
}

function normalizePacketName(value: string): string {
  return value
    .trim()
    .replace(/\.(draft|superseded)\.md$/i, '')
    .replace(/\.md$/i, '')
    .replace(/^#+\s*/, '')
    .trim();
}

function hasPacketHeading(body: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'im'),
    new RegExp(`^${escaped}\\s*:\\s*.+$`, 'im'),
    new RegExp(`^[-*]\\s*${escaped}\\s*:\\s*.+$`, 'im'),
  ];
  return patterns.some(pattern => pattern.test(body));
}

function hasReadablePacketStart(content: string): boolean {
  const firstLine = (content.split('\n')[0] ?? '').trim().replace(/^\uFEFF/, '');
  return firstLine === '---' || /^#{1,3}\s+.+/.test(firstLine);
}

export function showStatus(root: string): void {
  let config;
  try {
    config = readDisciplineConfig(root);
  } catch {
    config = null;
  }

  console.log('\n=== Discipline Loop Pipeline Status ===\n');
  if (config) {
    console.log(`Project: ${config.projectName}\nLane: ${config.lane} | Profile: ${config.profile} | Backend: ${config.backendProvider}\n`);
  }

  const packetsDir = path.join(root, '.discipline', 'packets');
  console.log('Present packets:');
  if (fs.existsSync(packetsDir)) {
    const files = fs.readdirSync(packetsDir).filter(fileName => fileName.endsWith('.md'));
    for (const name of ALL_PACKET_NAMES) {
      const present = files.some(fileName => fileName.includes(name));
      console.log(`  ${present ? '[x]' : '[ ]'} ${name}`);
    }
  }

  const pendingDir = path.join(root, '.discipline', 'patches', 'pending');
  const appliedDir = path.join(root, '.discipline', 'patches', 'applied');
  console.log(`\nPending patches: ${fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter(fileName => fileName.endsWith('.md')).length : 0}`);
  console.log(`Applied patches: ${fs.existsSync(appliedDir) ? fs.readdirSync(appliedDir).filter(fileName => fileName.endsWith('.md')).length : 0}`);

  const progressPath = path.join(root, 'progress.md');
  if (fs.existsSync(progressPath)) {
    const progressContent = fs.readFileSync(progressPath, 'utf-8');
    const workingMatch = progressContent.match(/Working on:\s*(.+)/);
    if (workingMatch) console.log(`\nWorking on: ${workingMatch[1]}`);
  }

  const issues = validateDiscipline(root);
  const errors = issues.filter(issue => issue.severity === 'error');
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    errors.forEach(error => console.log(`  [ERROR] ${error.message}${error.detail ? ` - ${error.detail}` : ''}`));
  } else {
    console.log('\nStatus: OK');
  }
  console.log('');
}

if (statusMode) {
  showStatus(projectRoot);
} else {
  const issues = validateDiscipline(projectRoot);
  issues.filter(issue => issue.severity === 'warning').forEach(issue => console.warn(`[WARN] ${issue.message}`));
  issues.filter(issue => issue.severity === 'error').forEach(issue => console.error(`[ERROR] ${issue.message}${issue.detail ? ` - ${issue.detail}` : ''}`));
  if (issues.filter(issue => issue.severity === 'error').length === 0) {
    disciplineInfo(`Validation OK. ${issues.filter(issue => issue.severity === 'warning').length} warning(s).`);
  } else {
    process.exit(1);
  }
}
