#!/usr/bin/env npx tsx
/**
 * discipline - two-layer local CLI over the existing discipline:* scripts.
 *
 * Layer 1 (deterministic, default): prepares, validates, and packages. No LLM,
 * no network, no cost. It dispatches to the existing npm scripts via child_process.
 * It does not reimplement logic or change the base script behavior.
 * Layer 2 (LLM, opt-in via --with-llm): implemented for `run` and
 * `cross-validate` (Phase 2). Those two spawn headless provider CLIs and never
 * hide cost, network, or provider dependency. Every OTHER command still exits 2
 * with an honest message naming the two commands that DO support --with-llm.
 *
 * Usage: npm run discipline -- <command> [args]   |   npx tsx tools/discipline/cli.ts <command>
 */
import { spawnSync } from 'node:child_process'

/** Providers accepted by --provider (Phase 2 enum). Matches the adapter registry. */
const PROVIDERS = ['claude', 'codex', 'gemini', 'cursor']
/** The only two commands that support --with-llm today. */
const LLM_COMMANDS = ['run', 'cross-validate']

interface CommandSpec {
  /** npm script to dispatch to (reuses the existing script layer; does not reimplement). */
  script: string
  /** Honest next-action note after success for steps whose generation is LLM-driven. */
  note?: string
  /** Args injected before the user's passthrough (e.g. a sub-action of the target script). */
  prependArgs?: string[]
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
  lease: { script: 'discipline:lease' },
  // Checkpoints (approval packets). `checkpoint` passes its sub-action through
  // verbatim (e.g. `discipline checkpoint create --slice S1 --kind scope`).
  // `approve`/`reject` are convenience aliases that inject the sub-action.
  checkpoint: { script: 'discipline:checkpoint' },
  approve: { script: 'discipline:checkpoint', prependArgs: ['approve'] },
  reject: { script: 'discipline:checkpoint', prependArgs: ['reject'] },
  'cross-validate': { script: 'discipline:cross-validate' },
  // Phase 2 reconciler. `run` supports --with-llm (headless builder); its plain
  // (deterministic) form runs the reconciler's level 0/1 plumbing only.
  run: { script: 'discipline:run' },
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
      '  gate --json      Runs the gate and writes .discipline/gate-report.json (machine-readable)',
      '  lease            Slice lease: `lease acquire|release|status <slice-id> [--force]`',
      '  checkpoint       Approval packet: `checkpoint create --slice <id> --kind pre-commit|scope|deploy`',
      '  approve|reject   Decide a checkpoint: `approve <packet-file-or-id>` / `reject <..> [--reason "..."]`',
      '  run              Reconciler: one stateless tick for one slice (level 0/1 plumbing without --with-llm)',
      '  patch | assemble | progress | watch | cross-validate',
      '',
      'LLM layer (opt-in, spawns a headless provider CLI; never hides cost/network):',
      '  run --with-llm [--provider claude|codex|gemini|cursor] --slice <id> [--autonomy 0..3]',
      '                   Runs the slice with a headless builder, gate, repair budget, advisory',
      '                   cross-validation, and STOPS before commit. --provider overrides the builder.',
      '  cross-validate --with-llm [--provider X]',
      '                   Runs JUST the advisory cross-validation against the current diff.',
      '  Any OTHER command with --with-llm exits 2 (only the two above are supported).',
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

/** Read the value of `--provider <x>` (or `--provider=x`) from argv, if present. */
function readProvider(args: string[]): { present: boolean; value?: string } {
  const eq = args.find((a) => a.startsWith('--provider='))
  if (eq) return { present: true, value: eq.slice('--provider='.length) }
  const idx = args.indexOf('--provider')
  if (idx === -1) return { present: false }
  return { present: true, value: idx + 1 < args.length ? args[idx + 1] : undefined }
}

const withLlm = argv.includes('--with-llm')
const providerArg = readProvider(argv)

// --provider only makes sense with the LLM layer (--with-llm). Without it, fail clearly
// instead of silently dropping the flag: the user could think they invoked the LLM layer
// when they actually ran the deterministic layer. (Preserved Phase-1 behavior.)
if (providerArg.present && !withLlm) {
  console.error(
    'discipline: --provider only applies with --with-llm (LLM layer). Remove --provider or add --with-llm.',
  )
  process.exit(1)
}

if (withLlm && !LLM_COMMANDS.includes(cmd)) {
  // Honest message: only `run` and `cross-validate` support --with-llm today.
  console.error(
    [
      `discipline ${cmd} --with-llm: this command does not support the LLM layer.`,
      `Only these commands run a headless provider: ${LLM_COMMANDS.map((c) => `discipline ${c} --with-llm`).join(', ')}.`,
      'For step generation, run the matching skill (for example /discipline-step1) in your agent.',
    ].join('\n'),
  )
  process.exit(2)
}

// Validate the provider value when supplied (must be a known adapter).
if (withLlm && providerArg.present && (!providerArg.value || !PROVIDERS.includes(providerArg.value))) {
  console.error(
    `discipline: --provider must be one of ${PROVIDERS.join('|')} (got "${providerArg.value ?? ''}").`,
  )
  process.exit(1)
}

// --- Route the two --with-llm commands -------------------------------------
if (withLlm && cmd === 'run') {
  // Map --provider -> builder override for the reconciler; strip --with-llm and
  // the --provider token(s) so only reconciler flags reach discipline:run.
  const rest = stripProviderAndLlm(argv.slice(1))
  const providerFlags = providerArg.value ? ['--builder', providerArg.value] : []
  const runArgs = ['run', 'discipline:run', '--', ...rest, ...providerFlags]
  const runResult = spawnSync('npm', runArgs, { stdio: 'inherit', shell: true })
  process.exit(runResult.status ?? 1)
}

if (withLlm && cmd === 'cross-validate') {
  // Advisory cross-validation against the current diff. Runs the reconciler in a
  // cross-validate-only mode (no builder). --provider overrides the validator.
  const rest = stripProviderAndLlm(argv.slice(1))
  const providerFlags = providerArg.value ? ['--validator', providerArg.value] : []
  const cvArgs = ['run', 'discipline:run', '--', '--cross-validate-only', ...rest, ...providerFlags]
  const cvResult = spawnSync('npm', cvArgs, { stdio: 'inherit', shell: true })
  process.exit(cvResult.status ?? 1)
}

/** Remove --with-llm and any --provider token(s) from a passthrough arg list. */
function stripProviderAndLlm(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--with-llm') continue
    if (a === '--provider') { i++; continue } // skip the flag and its value
    if (a.startsWith('--provider=')) continue
    out.push(a)
  }
  return out
}

// Remaining args pass through unchanged to the base script.
// (the --with-llm commands already exited above; they never reach here.)
const passthrough = argv.slice(1)

// `discipline gate --json` routes to the machine-readable gate report
// (writes .discipline/gate-report.json), instead of the plain human gate.
// Plain `discipline gate` is unchanged.
if (cmd === 'gate' && passthrough.includes('--json')) {
  const forwarded = passthrough.filter((a) => a !== '--json')
  const gateArgs = ['run', 'discipline:gate:report', ...(forwarded.length ? ['--', ...forwarded] : [])]
  const gateResult = spawnSync('npm', gateArgs, { stdio: 'inherit', shell: true })
  process.exit(gateResult.status ?? 1)
}

const spec = COMMANDS[cmd]
const forwardedArgs = [...(spec.prependArgs ?? []), ...passthrough]
const npmArgs = ['run', spec.script, ...(forwardedArgs.length ? ['--', ...forwardedArgs] : [])]
const result = spawnSync('npm', npmArgs, { stdio: 'inherit', shell: true })

if (result.status === 0 && spec.note) {
  console.log(`\n[discipline ${cmd}] ${spec.note}`)
}

process.exit(result.status ?? 1)