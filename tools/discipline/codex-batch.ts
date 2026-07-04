/**
 * discipline:codex-batch
 *
 * Reads task_plan.md to find simple slices (complexity S, status ready),
 * assembles context for each, and creates parallel Codex tasks.
 *
 * Usage:
 *   npm run discipline:codex-batch                    # process all S-complexity ready slices
 *   npm run discipline:codex-batch -- --dry-run       # show what would be sent without creating tasks
 *   npm run discipline:codex-batch -- --slice 2       # process specific slice number only
 *   npm run discipline:codex-batch -- --max 5         # limit parallel tasks (default: 5)
 *
 * Requires:
 *   - CODEX_API_KEY or OPENAI_API_KEY in environment
 *   - task_plan.md with Ready Slices table
 *   - .discipline/step4-outputs/READY_SLICES_BLOCK.md with expanded slices
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import { disciplineInfo, disciplineError, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const dryRun = args['dry-run'] === true;
const targetSlice = args.slice !== undefined ? Number(args.slice) : null;
const maxParallel = args.max ? Number(args.max) : 5;

interface SliceInfo {
  number: number;
  name: string;
  complexity: string;
  dependencies: string;
  status: string;
}

interface CodexTask {
  slice: SliceInfo;
  context: string;
  taskId?: string;
  status: 'pending' | 'created' | 'error';
  error?: string;
}

function readIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
}

function parseReadySlices(taskPlan: string): SliceInfo[] {
  const slices: SliceInfo[] = [];

  // Find the Ready Slices table
  const tableMatch = taskPlan.match(/## (?:4\) )?Ready Slices[\s\S]*?\n((?:\|.*\|\n)+)/);
  if (!tableMatch) return slices;

  const lines = tableMatch[1].trim().split('\n');

  for (const line of lines) {
    // Skip header and separator rows
    if (line.includes('---') || line.includes('Slice') && line.includes('Complexity')) continue;

    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;

    const num = parseInt(cells[0].replace(/[^0-9]/g, ''), 10);
    if (isNaN(num)) continue;

    slices.push({
      number: num,
      name: cells[1],
      complexity: cells[2].toUpperCase(),
      dependencies: cells[3],
      status: cells[4].toLowerCase(),
    });
  }

  return slices;
}

function extractSliceContext(sliceNum: number, slicesBlock: string): string | null {
  // Find the section for this slice in READY_SLICES_BLOCK
  const pattern = new RegExp(
    `## Slice ${sliceNum}:[\\s\\S]*?(?=## Slice \\d+:|$)`,
  );
  const match = slicesBlock.match(pattern);
  return match ? match[0].trim() : null;
}

function buildCodexPrompt(slice: SliceInfo, sliceContext: string, disciplineContent: string, archPacket: string): string {
  return `You are implementing a single slice of a Discipline Loop pipeline project.

## Slice to implement

${sliceContext}

## Project contracts (from discipline.md)

${disciplineContent.slice(0, 4000)}

## Architecture context

${archPacket.slice(0, 3000)}

## Instructions

1. Implement ONLY what is in Scope IN. Do not touch anything in Scope OUT.
2. Follow the contracts exactly. Do not invent business logic.
3. Create or modify only the files listed in Scope IN.
4. Write tests for the acceptance criteria.
5. Run the gate command after implementation.
6. If any acceptance criterion cannot be met, document why in a comment.

## Important rules

- One writer per slice. You are the writer for this slice.
- Do not modify discipline.md, task_plan.md, or progress.md.
- Do not refactor code outside the scope of this slice.
- Use existing patterns from the codebase. Do not introduce new patterns.
`;
}

async function createCodexTask(prompt: string, repoUrl?: string): Promise<string> {
  const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing CODEX_API_KEY or OPENAI_API_KEY environment variable');
  }

  const response = await fetch('https://api.openai.com/v1/codex/tasks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      repo: repoUrl || undefined,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Codex API error (${response.status}): ${error}`);
  }

  const data = await response.json() as { id: string };
  return data.id;
}

async function main() {
  // Read required files
  const taskPlan = readIfExists(path.join(projectRoot, 'task_plan.md'));
  if (!taskPlan) {
    disciplineError('task_plan.md not found. Run /discipline-step4 first.');
  }

  const slicesBlock = readIfExists(path.join(projectRoot, '.discipline', 'step4-outputs', 'READY_SLICES_BLOCK.md'));
  if (!slicesBlock) {
    disciplineError('READY_SLICES_BLOCK.md not found in .discipline/step4-outputs/. Run /discipline-step4 first.');
  }

  const disciplineContent = readIfExists(path.join(projectRoot, 'discipline.md')) || '';
  const archPacket = readIfExists(path.join(projectRoot, '.discipline', 'packets', 'STEP_4_EXECUTION_PACKET.md')) || '';

  // Parse and filter slices
  const allSlices = parseReadySlices(taskPlan!);
  let eligibleSlices = allSlices.filter(s => s.complexity === 'S' && s.status === 'ready');

  if (targetSlice !== null) {
    eligibleSlices = eligibleSlices.filter(s => s.number === targetSlice);
    if (eligibleSlices.length === 0) {
      disciplineError(`Slice ${targetSlice} not found, not complexity S, or not status ready.`);
    }
  }

  if (eligibleSlices.length === 0) {
    disciplineInfo('No eligible slices found (complexity S + status ready).');
    disciplineInfo(`Total slices in plan: ${allSlices.length}`);
    disciplineInfo(`Breakdown: ${allSlices.filter(s => s.complexity === 'S').length}S, ${allSlices.filter(s => s.complexity === 'M').length}M, ${allSlices.filter(s => s.complexity === 'L').length}L`);
    process.exit(0);
  }

  disciplineInfo(`Found ${eligibleSlices.length} eligible slice(s) (complexity S, status ready):\n`);

  // Prepare tasks
  const tasks: CodexTask[] = [];

  for (const slice of eligibleSlices) {
    const sliceContext = extractSliceContext(slice.number, slicesBlock!);
    if (!sliceContext) {
      disciplineWarn(`Slice ${slice.number} (${slice.name}): no expanded context found in READY_SLICES_BLOCK. Skipping.`);
      continue;
    }

    const prompt = buildCodexPrompt(slice, sliceContext, disciplineContent, archPacket);

    tasks.push({
      slice,
      context: prompt,
      status: 'pending',
    });

    console.log(`  Slice ${slice.number}: ${slice.name} [${slice.complexity}]`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would create ${tasks.length} Codex task(s).`);
    console.log('Run without --dry-run to create tasks.\n');

    for (const task of tasks) {
      console.log(`--- Slice ${task.slice.number}: ${task.slice.name} ---`);
      console.log(`Context length: ${task.context.length} chars`);
      console.log(`Dependencies: ${task.slice.dependencies}`);
      console.log('');
    }

    process.exit(0);
  }

  // Create tasks in parallel with concurrency limit
  disciplineInfo(`\nCreating ${tasks.length} Codex task(s) (max ${maxParallel} parallel)...\n`);

  const batches: CodexTask[][] = [];
  for (let i = 0; i < tasks.length; i += maxParallel) {
    batches.push(tasks.slice(i, i + maxParallel));
  }

  for (const batch of batches) {
    await Promise.allSettled(
      batch.map(async (task) => {
        try {
          const taskId = await createCodexTask(task.context);
          task.taskId = taskId;
          task.status = 'created';
          disciplineInfo(`✓ Slice ${task.slice.number} (${task.slice.name}): task created -> ${taskId}`);
        } catch (err) {
          task.status = 'error';
          task.error = err instanceof Error ? err.message : String(err);
          disciplineWarn(`✗ Slice ${task.slice.number} (${task.slice.name}): ${task.error}`);
        }
      }),
    );
  }

  // Summary
  const created = tasks.filter(t => t.status === 'created');
  const errors = tasks.filter(t => t.status === 'error');

  console.log(`\n${created.length} task(s) created, ${errors.length} error(s).`);

  if (created.length > 0) {
    console.log('\nCreated tasks:');
    for (const t of created) {
      console.log(`  Slice ${t.slice.number} (${t.slice.name}) -> ${t.taskId}`);
    }
  }

  if (errors.length > 0) {
    console.log('\nFailed:');
    for (const t of errors) {
      console.log(`  Slice ${t.slice.number} (${t.slice.name}): ${t.error}`);
    }
    process.exit(1);
  }

  console.log('\nNext: review Codex task outputs and merge approved changes.');
}

main();
