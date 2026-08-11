import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineError, disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { copyToClipboard } from './lib/clipboard.js';
import { STEP_ASSEMBLY_MAP, VALID_STEPS } from './lib/artifact-flow.js';
import { locateSlicePacket, normalizeSliceId, packetStatus, slicePasteReadyFileName } from './lib/slice-identity.js';
import { readStep5Packet } from './lib/step5-schema.js';
import { inspectStep5Implementability, METRICS_FILE, readMetricRecords } from './lib/metrics.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const step = args.step?.toString();
const slice = args.slice !== undefined ? String(args.slice) : undefined;
const useClipboard = args.clipboard === true;
const allowDraft = args['allow-draft'] === true;
const openUrl = args.open === true;

function optionalPacketsForStep5(slicePacket: string, configuredPackets: string[]): string[] {
  const declaration = slicePacket.match(/^CONTEXT_PACKETS:\s*(.+?)\s*$/mi);
  if (!declaration) {
    disciplineWarn('STEP_5_SLICE_PACKET has no CONTEXT_PACKETS declaration; no optional context packets were included.');
    return [];
  }

  const requested = new Set(declaration[1].split(',').map(value => value.trim().replace(/\.md$/, '')).filter(Boolean));
  const supported = new Set(configuredPackets.map(packet => packet.replace(/\.md$/, '')));
  const unknown = [...requested].filter(packet => packet !== 'none' && !supported.has(packet));
  if (unknown.length > 0) disciplineWarn(`Ignoring unsupported Step 5 context packet(s): ${unknown.join(', ')}`);

  return configuredPackets.filter(packet => requested.has(packet.replace(/\.md$/, '')));
}

export async function assemblePasteReady(root: string, stepId: string, sliceId?: string, options: { allowDraft?: boolean } = {}): Promise<string> {
  const config = STEP_ASSEMBLY_MAP[stepId];
  // Throw, never exit: watch.ts and run.ts import this, and a process.exit here kills their tick
  // mid-way, past the point where they could report what failed. The CLI entrypoint exits.
  if (!config) throw new Error(`Step "${stepId}" is not valid. Valid steps: ${VALID_STEPS.join(', ')}`);
  if (sliceId !== undefined && stepId !== '5') {
    throw new Error(`--slice only applies to Step 5 (got --step ${stepId}). Every other step has one handoff, not one per slice.`);
  }

  // Step 4 consumes metric history as evidence, not as arbitrary context text. Validate every
  // signature before any output directory or handoff is written; a blocker in state-view is too
  // late when the same corrupted bytes have already been handed to the planning model.
  const metricsContext = METRICS_FILE.replace(/\\/g, '/');
  if (config.includeProjectFiles?.some((file) => file.replace(/\\/g, '/') === metricsContext)) {
    readMetricRecords(root);
  }

  const packetsDir = path.join(root, '.discipline', 'packets');
  const pasteReadyDir = path.join(root, '.discipline', 'paste-ready');
  const promptsDir = path.join(root, '.discipline', 'prompts');
  if (!fs.existsSync(pasteReadyDir)) fs.mkdirSync(pasteReadyDir, { recursive: true });

  const sections: string[] = [];
  const missing: string[] = [];
  const requiredPacketContents = new Map<string, string>();

  // Step 5 with a slice: the packet is resolved by identity, not by whatever sits in the generic
  // slot, and the handoff is written per slice so two ready slices never overwrite each other.
  let outputFile = config.outputFile;
  let slicePacketPath: string | null = null;
  if (stepId === '5' && sliceId !== undefined) {
    const taskPlanPath = path.join(root, 'task_plan.md');
    const taskPlan = fs.existsSync(taskPlanPath) ? fs.readFileSync(taskPlanPath, 'utf-8') : undefined;
    const located = locateSlicePacket(root, sliceId, taskPlan);
    if (!located.ok) throw new Error(located.message);
    for (const warning of (located as { warnings: string[] }).warnings) disciplineWarn(warning);
    slicePacketPath = (located as { path: string }).path;
    outputFile = slicePasteReadyFileName(sliceId);

    // Every Step 5 handoff is assembled here: the watcher, `discipline run` at every level and the
    // manual command all come through this one door, so this is where a packet nobody should build
    // from stops. A legacy packet only warns; it never promised this much.
    const slicePacketContent = fs.readFileSync(slicePacketPath, 'utf-8');

    // A paste-ready IS the implementation handoff. The runner refuses a packet that is not `ready`
    // and the watcher only selects ready ones, so the manual command was the one path that handed
    // an implementer a draft: a spec Step 4 has not finished, with its defects reported as warnings
    // precisely because it never claimed to be done. `--allow-draft` is for reading it, not building.
    // `--allow-draft` covers EXACTLY `draft`, the one state that means "being written". `consumed`
    // and `superseded` mean the opposite: that slice is over. A flag named for drafts that also
    // reopened closed work would be a second door into the thing Fase 1 spent four rounds closing.
    const declaredStatus = packetStatus(slicePacketContent);
    if (declaredStatus && declaredStatus !== 'ready') {
      const inspectable = declaredStatus === 'draft' && options.allowDraft === true;
      if (!inspectable) {
        throw new Error(
          `${path.basename(slicePacketPath)} has status "${declaredStatus}", not "ready": a paste-ready is the handoff an implementer builds from. `
          + (declaredStatus === 'draft'
            ? 'Finish the packet and set status: ready, or pass --allow-draft to assemble it for inspection only.'
            : `--allow-draft does not cover "${declaredStatus}"; only a draft is work in progress. Reopen the slice deliberately if that is what you mean.`),
        );
      }
    }

    const reading = readStep5Packet(slicePacketContent, slicePacketPath);
    const blocking = reading.findings.filter((finding) => finding.severity === 'error');
    for (const finding of reading.findings.filter((f) => f.severity === 'warning')) disciplineWarn(`  ${finding.message}`);
    if (declaredStatus === 'draft' && options.allowDraft) {
      disciplineWarn('  --allow-draft: assembling a packet whose status is "draft". This handoff is for inspection; do not implement from it.');
    }
    if (blocking.length > 0) {
      throw new Error(
        `${path.basename(slicePacketPath)} does not meet the contract it declares. `
        + `Fix the packet (or set status: draft while you finish it):\n  - ${blocking.map((f) => (f.detail ? `${f.message} (${f.detail})` : f.message)).join('\n  - ')}`,
      );
    }
    if (!(declaredStatus === 'draft' && options.allowDraft)) {
      const implementability = inspectStep5Implementability(root, slicePacketContent, slicePacketPath, sliceId);
      if (!implementability.ok) {
        throw new Error(`${path.basename(slicePacketPath)} is not implementable:\n  - ${implementability.reasons.join('\n  - ')}`);
      }
    }
  }

  for (const p of config.requiredPackets) {
    if (slicePacketPath && p === 'STEP_5_SLICE_PACKET.md') {
      const content = fs.readFileSync(slicePacketPath, 'utf-8');
      requiredPacketContents.set(p, content);
      sections.push(`### ${path.basename(slicePacketPath, '.md')}

${content}`);
      continue;
    }
    const pp = path.join(packetsDir, p);
    if (!fs.existsSync(pp)) missing.push(p);
    else {
      const content = fs.readFileSync(pp, 'utf-8');
      requiredPacketContents.set(p, content);
      sections.push(`### ${p.replace('.md', '')}\n\n${content}`);
    }
  }
  if (missing.length > 0) throw new Error(`Missing required packets for Step ${stepId}:\n  ${missing.join('\n  ')}`);

  const optionalPackets = stepId === '5'
    ? optionalPacketsForStep5(requiredPacketContents.get('STEP_5_SLICE_PACKET.md') || '', config.optionalPackets)
    : config.optionalPackets;
  for (const p of optionalPackets) {
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
  // A per-slice handoff says which slice it is for in its own header: the reader should not have
  // to infer it from the filename, and the next tool can check it instead of trusting the slot.
  const sliceLine = sliceId !== undefined ? `SLICE: ${normalizeSliceId(sliceId)}\n` : '';
  const assembled = `# Paste-Ready Block - Step ${stepId}\n\n${sliceLine}STATUS: ready\nGENERATED_BY: discipline:assemble\nDATE: ${date}\n\n---\n\n${promptContent}\n\n---\n\n## PASTED INPUTS\n\n${sections.join('\n\n---\n\n')}\n`;

  fs.writeFileSync(path.join(pasteReadyDir, outputFile), assembled, 'utf-8');
  disciplineInfo(`Assembled: .discipline/paste-ready/${outputFile}`);
  return assembled;
}

// Only execute as CLI when invoked directly (npm run discipline:assemble).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!step) disciplineError(`Missing --step. Usage: discipline:assemble --step <${VALID_STEPS.join('|')}>`);
  assemblePasteReady(projectRoot, step!, slice, { allowDraft }).then(assembled => {
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
