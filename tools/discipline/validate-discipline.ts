import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import type { ValidationIssue } from './lib/types.js';
import { disciplineInfo } from './lib/types.js';
import { resolveProjectRoot, readDisciplineConfig } from './lib/discipline-config.js';
import {
  DISCIPLINE_MD_ANCHORS, TASK_PLAN_ANCHORS, FINDINGS_ANCHORS, PROGRESS_ANCHORS,
  TASK_PLAN_ARCHIVE_ANCHORS, FINDINGS_ARCHIVE_ANCHORS,
} from './lib/anchors.js';
import { ALL_PACKET_NAMES } from './lib/artifact-flow.js';
import { parsePacketFile } from './lib/parse-packet.js';
import { parsePacketMeta } from './lib/packet-meta.js';
import { findSliceHeadings, isActiveSlicePacketName, parseReadySlicesTable, resolvePacketIdentity, resolveSlice, slicePacketFileName, type SliceHeading } from './lib/slice-identity.js';
import { readStep5Packet } from './lib/step5-schema.js';
import { validateScorecard, type ScorecardMode } from './validate-scorecard.js';
import { formatBytes, inspectDisciplineDocuments } from './lib/document-health.js';
import { STATE_VIEW_FILE, writeStateView } from './lib/state-view.js';

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
  checkOptionalArchive(root, 'task_plan_archive.md', [...TASK_PLAN_ARCHIVE_ANCHORS], issues);
  checkOptionalArchive(root, 'findings_archive.md', [...FINDINGS_ARCHIVE_ANCHORS], issues);

  for (const dir of ['.discipline/packets', '.discipline/patches/pending', '.discipline/patches/applied', '.discipline/paste-ready']) {
    if (!fs.existsSync(path.join(root, dir))) {
      issues.push({ severity: 'error', message: `Missing directory: ${dir}`, detail: 'npm run discipline:hydrate' });
    }
  }

  checkPacketSemantics(root, issues);
  checkPacketFrontmatter(root, issues);
  checkSliceIdentity(root, issues);
  checkProgressLength(root, issues);
  checkDocumentGrowth(root, issues);
  checkProfileScorecard(root, issues);
  return issues;
}

function checkOptionalArchive(root: string, fileName: string, expected: string[], issues: ValidationIssue[]) {
  const full = path.join(root, fileName);
  if (!fs.existsSync(full)) {
    issues.push({
      severity: 'warning',
      file: fileName,
      message: `${fileName} is missing; run npm run discipline:hydrate to add the reviewable archive scaffold.`,
    });
    return;
  }
  checkAnchors(root, fileName, expected, issues);
}

function checkDocumentGrowth(root: string, issues: ValidationIssue[]) {
  for (const document of inspectDisciplineDocuments(root).filter((item) => item.file === 'task_plan.md' || item.file === 'findings.md')) {
    if (!document.warning) continue;
    const high = document.warning === 'high' ? '[HIGH] ' : '';
    issues.push({
      severity: 'warning',
      file: document.file,
      message: `${high}${document.file} has ${formatBytes(document.bytes)} and ${document.lines} lines; archive reviewed human prose through patch blocks.`,
      detail: document.warning === 'high'
        ? 'Above 500 KB. Keep the current document compact and move history to its archive.'
        : 'Warning threshold: 250 KB or 2,000 lines.',
    });
  }
}

/**
 * Slice identity, checked before anything acts on it. Everything here is an ERROR rather than a
 * warning: a slice the plan describes twice, a plan whose table and section disagree about a
 * status, or a packet claiming two different slices are all states where the next command would
 * have to guess. Guessing is what this whole module exists to prevent.
 */
function checkSliceIdentity(root: string, issues: ValidationIssue[]) {
  const taskPlanPath = path.join(root, 'task_plan.md');
  if (fs.existsSync(taskPlanPath)) {
    const taskPlan = fs.readFileSync(taskPlanPath, 'utf-8');
    const seen = new Map<string, SliceHeading[]>();
    for (const heading of findSliceHeadings(taskPlan)) {
      const list = seen.get(heading.id) ?? [];
      list.push(heading);
      seen.set(heading.id, list);
    }
    for (const [id, headings] of seen) {
      if (headings.length > 1) {
        issues.push({
          severity: 'error',
          message: `task_plan.md describes slice "${id}" ${headings.length} times`,
          detail: `lines ${headings.map((h) => h.line + 1).join(', ')}: two sections for one slice make its status ambiguous`,
        });
        continue;
      }
      // resolveSlice compares the §4 table against the slice's own section.
      const resolution = resolveSlice(taskPlan, id);
      if (!resolution.ok && resolution.reason === 'contradiction') {
        issues.push({ severity: 'error', message: `task_plan.md contradicts itself about slice "${id}"`, detail: resolution.message });
      }
    }
    const rows = new Map<string, number[]>();
    for (const row of parseReadySlicesTable(taskPlan)) {
      rows.set(row.id, [...(rows.get(row.id) ?? []), row.line + 1]);
    }
    for (const [id, lines] of rows) {
      if (lines.length > 1) {
        issues.push({
          severity: 'error',
          message: `§4 Ready Slices lists slice "${id}" ${lines.length} times`,
          detail: `lines ${lines.join(', ')}: keep one row per slice`,
        });
      }
    }
  }

  const packetsDir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(packetsDir)) return;
  for (const file of fs.readdirSync(packetsDir).filter((f) => f.endsWith('.md'))) {
    if (!/(STEP_5_SLICE_PACKET|SLICE_COMPLETION_PACKET)/i.test(file)) continue;
    const content = fs.readFileSync(path.join(packetsDir, file), 'utf-8');
    const identity = resolvePacketIdentity(content, file);
    if (!identity.ok) {
      issues.push({ severity: 'error', message: `${file} claims more than one slice`, detail: identity.message });
      continue;
    }
    // An ACTIVE slice packet whose slice the plan does not state exactly once is an orphan: the
    // next assemble or run would act on a slice nobody planned. Archived packets are history and
    // are left alone. Which names count as active is decided in ONE place, the same function the
    // watcher and the assembler use: this file's own copy of the rule read `_13.consumed` as an
    // ordinary suffix, so an archived packet was reported as an orphan.
    const active = isActiveSlicePacketName(file);
    if (active && identity.id && fs.existsSync(path.join(root, 'task_plan.md'))) {
      const plan = fs.readFileSync(path.join(root, 'task_plan.md'), 'utf-8');
      const resolution = resolveSlice(plan, identity.id);
      // Listed in the §4 table but not expanded yet is a plan in progress, not an orphan packet.
      const listed = parseReadySlicesTable(plan).some((row) => row.id === identity.id);
      if (!resolution.ok && resolution.reason === 'not-found' && !listed) {
        issues.push({
          severity: 'error',
          message: `${file} is for slice "${identity.id}", which task_plan.md does not describe`,
          detail: 'expand the slice in Step 4, or archive the packet if the slice is gone',
        });
      }
    }

    // A generic STEP_5_SLICE_PACKET.md still works, but one packet per file is what keeps two
    // slices from sharing a slot, so say it every time rather than at some future migration.
    if (identity.id && /^STEP_5_SLICE_PACKET\.md$/i.test(file)) {
      issues.push({
        severity: 'warning',
        message: 'STEP_5_SLICE_PACKET.md uses the legacy generic name',
        detail: `rename it to ${slicePacketFileName(identity.id)} so each slice keeps its own file`,
      });
    }
  }
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
    // The suffixed name is the CANONICAL one since Fase 1, so it cannot be the less-checked one.
    // `STEP_5_SLICE_PACKET_13.md` resolved to the rule key "STEP_5_SLICE_PACKET_13", which matches
    // no rule, so every canonically named Step 5 packet skipped these checks entirely: a v2 packet
    // that said `ready` and met none of its contract passed `discipline:validate` in silence.
    const packetName = collapseSlicePacketName(normalizePacketName(parsed.name || fileName));
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

    // The Step 5 packet has a versioned contract of its own. A v2 packet is read against it (as
    // errors once it says `ready`); a legacy one keeps the advisory heading nudges below, which is
    // the whole point of keeping v1 advisory: nothing already on disk turns red overnight.
    if (packetName === 'STEP_5_SLICE_PACKET') {
      const reading = readStep5Packet(fileContent, fileName);
      for (const finding of reading.findings) {
        issues.push({ severity: finding.severity, file: fileName, message: finding.message, detail: finding.detail });
      }
      if (reading.format === 'v2') continue;
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

/**
 * `STEP_5_SLICE_PACKET_13` and `STEP_5_SLICE_PACKET_13.2` are Step 5 packets, and the rules for one
 * are the rules for all. Only the Step 5 family is collapsed here: applying the completion-packet
 * rules to suffixed completion packets is a separate decision, not a side effect of this one.
 */
function collapseSlicePacketName(value: string): string {
  return /^STEP_5_SLICE_PACKET(_.+)?$/i.test(value) ? 'STEP_5_SLICE_PACKET' : value;
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

  console.log('\nDocument sizes:');
  for (const document of inspectDisciplineDocuments(root)) {
    console.log(`  ${document.exists ? '[x]' : '[ ]'} ${document.file}: ${formatBytes(document.bytes)}, ${document.lines} lines${document.warning ? ` (${document.warning === 'high' ? 'HIGH ' : ''}warning)` : ''}`);
  }
  try {
    writeStateView(root);
    console.log(`\nCurrent derived view: ${STATE_VIEW_FILE.replace(/\\/g, '/')}`);
  } catch (err) {
    console.log(`\nCurrent derived view unavailable: ${(err as Error).message}`);
  }

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
