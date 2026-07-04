#!/usr/bin/env npx tsx
/**
 * discipline - two-layer local CLI over the existing discipline:* scripts.
 *
 * Layer 1 (deterministic, default): prepares, validates, and packages. No LLM,
 * no network, no cost. It dispatches to the existing npm scripts via child_process.
 * It does not reimplement logic or change the base script behavior.
 * Layer 2 (LLM, opt-in via --with-llm): seam only. Not implemented yet: fails
 * clearly (exit 2) and never hides cost, network, or provider dependency.
 *
 * Usage: npm run discipline -- <command> [args]   |   npx tsx tools/discipline/cli.ts <command>
 */
import { spawnSync } from 'node:child_process'

interface CommandSpec {
  /** npm script to dispatch to (reuses the existing script layer; does not reimplement). */
  script: string
  /** Honest next-action note after success for steps whose generation is LLM-driven. */
  note?: string
}

const COMMANDS: Record<string, CommandSpec> = {
  step1: {
    script: 'discipline:step1-prep',
    note:
      'Step 1 is NOT complete: this only prepared inputs, prompts, and packet (deterministic).\n' +
      '  To GENERATE the PRD, run the /discipline-step1 skill in your agent,\n' +
      '  or use `discipline step1 --with-llm` when the LLM layer is available.',
  },
  step2: {
    script: 'discipline:validate:architecture',
    note:
      'Step 2: this VALIDATED the architecture (deterministic). Generation is produced by\n' +
      '  the /discipline-step2 skill in your agent (or --with-llm when available).',
  },
  gate: { script: 'gate' },
  publish: { script: 'discipline:release-pack' },
  validate: { script: 'discipline:validate' },
  doctor: { script: 'discipline:doctor' },
  status: { script: 'discipline:status' },
  patch: { script: 'discipline:patch' },
  assemble: { script: 'discipline:assemble' },
  progress: { script: 'discipline:progress' },
  watch: { script: 'discipline:watch' },
  'cross-validate': { script: 'discipline:cross-validate' },
}

function printHelp(): void {
  console.log(
    [
      'discipline - two-layer CLI over the existing discipline:* scripts.',
      '',
      'Usage: npm run discipline -- <command> [args]   (or: npx tsx tools/discipline/cli.ts <command>)',
      '',
      'Deterministic layer (default, no LLM, no cost):',
      '  step1            Prepares Step 1 inputs/prompts/packet (does NOT generate the PRD)',
      '  step2            Validates the Step 2 architecture',
      '  gate             Runs the lane gate (npm run gate)',
      '  publish          Generates the release pack',
      '  validate         Validates pipeline integrity',
      '  doctor           Project health diagnostics',
      '  status           Pipeline dashboard',
      '  patch | assemble | progress | watch | cross-validate',
      '',
      'LLM layer (opt-in, NOT IMPLEMENTED YET):',
      '  <command> --with-llm [--provider claude|codex]',
      '                   Would execute the step via headless LLM. Requires configured',
      '                   provider and explicit cost confirmation. Currently fails clearly (exit 2).',
      '',
      'The system decides and controls; the agent executes. This CLI only dispatches to',
      'existing scripts; it does not reimplement logic or hide cost/dependency.',
    ].join('\n'),
  )
}

const argv = process.argv.slice(2)
const cmd = argv[0]

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp()
  process.exit(0)
}

if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
  console.error(`discipline: unknown command "${cmd}". Run \`discipline help\`.`)
  process.exit(1)
}

// Layer 2 (seam): not implemented yet. Fail hard and clearly; never exit 0.
if (argv.includes('--with-llm')) {
  console.error(
    [
      'discipline --with-llm: LLM execution is not implemented yet.',
      'This command would require provider config (--provider claude|codex) and explicit cost confirmation.',
      'For now, run the matching skill (for example /discipline-step1) in your agent.',
    ].join('\n'),
  )
  process.exit(2)
}

// --provider only makes sense with the LLM layer (--with-llm). Without it, fail clearly
// instead of silently dropping the flag: the user could think they invoked the LLM layer
// when they actually ran the deterministic layer.
if (argv.includes('--provider')) {
  console.error(
    'discipline: --provider only applies with --with-llm (LLM layer). Remove --provider or add --with-llm.',
  )
  process.exit(1)
}

// Remaining args pass through unchanged to the base script.
// (--with-llm and --provider already exited above; they never reach here.)
const passthrough = argv.slice(1)

const spec = COMMANDS[cmd]
const npmArgs = ['run', spec.script, ...(passthrough.length ? ['--', ...passthrough] : [])]
const result = spawnSync('npm', npmArgs, { stdio: 'inherit', shell: true })

if (result.status === 0 && spec.note) {
  console.log(`\n[discipline ${cmd}] ${spec.note}`)
}

process.exit(result.status ?? 1)