/**
 * discipline:cross-validate
 *
 * Reads all packets in .discipline/packets/ and project context files,
 * then uses an LLM to detect inconsistencies between them.
 *
 * Usage:
 *   npm run discipline:cross-validate              # uses fixture mode (no API call)
 *   npm run discipline:cross-validate -- --live    # uses real LLM (requires API key)
 *
 * In fixture mode, runs deterministic structural checks only (free, no API).
 * In live mode, sends context to an LLM for deep inconsistency analysis.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import { disciplineInfo } from './lib/types.js';
import { resolveProjectRoot, readDisciplineConfig } from './lib/discipline-config.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const liveMode = args.live === true;

interface CrossValidationIssue {
  severity: 'error' | 'warning';
  source: string;
  target: string;
  message: string;
}

function readIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
}

function structuralValidation(root: string): CrossValidationIssue[] {
  const issues: CrossValidationIssue[] = [];

  const disciplineContent = readIfExists(path.join(root, 'discipline.md'));
  const taskPlan = readIfExists(path.join(root, 'task_plan.md'));
  const packetsDir = path.join(root, '.discipline', 'packets');

  if (!disciplineContent) return issues;

  let config;
  try { config = readDisciplineConfig(root); } catch { return issues; }

  // Read all packets
  const packets: Record<string, string> = {};
  if (fs.existsSync(packetsDir)) {
    for (const f of fs.readdirSync(packetsDir).filter(f => f.endsWith('.md') && !f.includes('.superseded.'))) {
      packets[f.replace('.md', '')] = fs.readFileSync(path.join(packetsDir, f), 'utf-8');
    }
  }

  // Check 1: LANE consistency
  const executionPacket = packets['STEP_4_EXECUTION_PACKET'] || packets['STEP_4_EXECUTION_PACKET.draft'] || '';
  if (executionPacket && config.lane) {
    const laneInPacket = executionPacket.match(/LANE[:\s=]+(\w+)/i);
    if (laneInPacket && laneInPacket[1].toUpperCase() !== config.lane.toUpperCase()) {
      issues.push({
        severity: 'error',
        source: 'discipline.md',
        target: 'STEP_4_EXECUTION_PACKET',
        message: `LANE mismatch: discipline.md says "${config.lane}" but execution packet says "${laneInPacket[1]}"`,
      });
    }
  }

  // Check 2: BACKEND_PROVIDER consistency
  if (executionPacket && config.backendProvider) {
    const backendInPacket = executionPacket.match(/BACKEND_PROVIDER[:\s=]+(\w+)/i);
    if (backendInPacket && backendInPacket[1].toUpperCase() !== config.backendProvider.toUpperCase()) {
      issues.push({
        severity: 'error',
        source: 'discipline.md',
        target: 'STEP_4_EXECUTION_PACKET',
        message: `BACKEND_PROVIDER mismatch: discipline.md says "${config.backendProvider}" but execution packet says "${backendInPacket[1]}"`,
      });
    }
  }

  // Check 3: AI_FEATURES consistency
  const aiPacket = packets['STEP_2_5_AI_PACKET'];
  if (aiPacket && (!config.aiFeatures || config.aiFeatures === 'none')) {
    issues.push({
      severity: 'warning',
      source: 'discipline.md',
      target: 'STEP_2_5_AI_PACKET',
      message: `AI packet exists but discipline.md has AI_FEATURES=none. Either enable AI or remove the packet.`,
    });
  }
  if (!aiPacket && config.aiFeatures && config.aiFeatures !== 'none') {
    issues.push({
      severity: 'warning',
      source: 'discipline.md',
      target: 'STEP_2_5_AI_PACKET',
      message: `discipline.md has AI_FEATURES=${config.aiFeatures} but no STEP_2_5_AI_PACKET exists.`,
    });
  }

  // Check 4: UI packet vs LANE
  const uiPacket = packets['UI_HANDOFF_PACKET'];
  const stitchPacket = packets['STEP_3_STITCH_PACKET'];
  if ((uiPacket || stitchPacket) && (config.lane === 'BACKEND' || config.lane === 'CLI')) {
    issues.push({
      severity: 'warning',
      source: 'discipline.md',
      target: uiPacket ? 'UI_HANDOFF_PACKET' : 'STEP_3_STITCH_PACKET',
      message: `UI packet exists but LANE=${config.lane} (no UI). This packet should not exist for this lane.`,
    });
  }

  // Check 5: Slice count in execution packet vs task_plan
  if (executionPacket && taskPlan) {
    const slicesInPacket = (executionPacket.match(/Slice\s+\d+/gi) || []).length;
    const slicesInPlan = (taskPlan.match(/^##\s+Slice\s+\d+/gmi) || []).length;
    if (slicesInPacket > 0 && slicesInPlan > 0 && Math.abs(slicesInPacket - slicesInPlan) > 2) {
      issues.push({
        severity: 'warning',
        source: 'STEP_4_EXECUTION_PACKET',
        target: 'task_plan.md',
        message: `Slice count divergence: execution packet mentions ~${slicesInPacket} slices but task_plan has ${slicesInPlan}. Review if they are in sync.`,
      });
    }
  }

  // Check 6: Execution packet STATUS
  if (packets['STEP_4_EXECUTION_PACKET']) {
    const content = packets['STEP_4_EXECUTION_PACKET'];
    if (!/STATUS:\s*validated/i.test(content)) {
      issues.push({
        severity: 'error',
        source: 'STEP_4_EXECUTION_PACKET',
        target: 'STEP_4_EXECUTION_PACKET',
        message: `Execution packet missing STATUS: validated. It may still be a draft.`,
      });
    }
  }

  // Check 7: COLLAB_MODE consistency between discipline.md and packets
  if (executionPacket && config.collabMode) {
    const collabInPacket = executionPacket.match(/COLLAB_MODE[:\s=]+(\w+)/i);
    if (collabInPacket && collabInPacket[1].toUpperCase() !== config.collabMode.toUpperCase()) {
      issues.push({
        severity: 'error',
        source: 'discipline.md',
        target: 'STEP_4_EXECUTION_PACKET',
        message: `COLLAB_MODE mismatch: discipline.md says "${config.collabMode}" but execution packet says "${collabInPacket[1]}"`,
      });
    }
  }

  return issues;
}

async function liveValidation(root: string): Promise<CrossValidationIssue[]> {
  disciplineInfo('Live cross-validation requires an LLM provider. Checking availability...');

  try {
    const { getProvider } = await import('../llm_providers/index.js');
    const provider = await getProvider(args.provider);

    // Gather all context
    const discipline = readIfExists(path.join(root, 'discipline.md')) || '';
    const taskPlan = readIfExists(path.join(root, 'task_plan.md')) || '';
    const findings = readIfExists(path.join(root, 'findings.md')) || '';

    const packetsDir = path.join(root, '.discipline', 'packets');
    let packetsContext = '';
    if (fs.existsSync(packetsDir)) {
      for (const f of fs.readdirSync(packetsDir).filter(f => f.endsWith('.md') && !f.includes('.superseded.'))) {
        const content = fs.readFileSync(path.join(packetsDir, f), 'utf-8');
        packetsContext += `\n--- ${f} ---\n${content.slice(0, 2000)}\n`;
      }
    }

    const input = `Review these project artifacts for inconsistencies.

Discipline Loop.MD (project constitution):
${discipline.slice(0, 3000)}

TASK_PLAN.MD:
${taskPlan.slice(0, 2000)}

FINDINGS.MD:
${findings.slice(0, 1000)}

PACKETS:
${packetsContext.slice(0, 5000)}

Find and report ONLY real inconsistencies between these artifacts. Check:
1. Do switches in discipline.md match what packets describe?
2. Do slices in task_plan match execution packet?
3. Are there contracts in discipline.md not reflected in packets?
4. Are there packets that contradict each other?
5. Are there scope items in execution packet not covered by any slice?

Return only real inconsistencies. If no issues are found, return an empty issues array.`;

    const responseSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['issues'],
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'source', 'target', 'message'],
            properties: {
              severity: { type: 'string', enum: ['error', 'warning'] },
              source: { type: 'string' },
              target: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    };

    const parsed = await provider.generateJson({
      model: args.model,
      system: 'You are a technical auditor. Return JSON that matches the provided schema. Do not include prose.',
      input,
      responseSchema,
    });
    return Array.isArray(parsed?.issues) ? parsed.issues : [];
  } catch (err) {
    disciplineInfo(`Live validation skipped: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// Main
async function main() {
  disciplineInfo(`Cross-validating packets${liveMode ? ' (live mode)' : ' (structural mode)'}...\n`);

  const structuralIssues = structuralValidation(projectRoot);

  let liveIssues: CrossValidationIssue[] = [];
  if (liveMode) {
    liveIssues = await liveValidation(projectRoot);
  }

  const allIssues = [...structuralIssues, ...liveIssues];

  if (allIssues.length === 0) {
    disciplineInfo('Cross-validation OK. No inconsistencies found.');
    process.exit(0);
  }

  const errors = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');

  for (const w of warnings) {
    console.warn(`[WARN] ${w.source} ↔ ${w.target}: ${w.message}`);
  }
  for (const e of errors) {
    console.error(`[ERROR] ${e.source} ↔ ${e.target}: ${e.message}`);
  }

  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s).`);

  if (errors.length > 0) process.exit(1);
}

main();
