#!/usr/bin/env npx tsx
/**
 * discipline - CLI local de dos capas sobre los scripts discipline:* existentes.
 *
 * Capa 1 (determinista, default): prepara, valida, empaqueta. Sin LLM, sin red, sin costo.
 *   Despacha a los npm scripts existentes via child_process. NO reimplementa logica
 *   ni cambia el comportamiento de los scripts base.
 * Capa 2 (LLM, opt-in via --with-llm): SEAM. Aun NO implementada: falla claro (exit 2),
 *   nunca oculta costo, red ni dependencia de provider.
 *
 * Uso: npm run discipline -- <comando> [args]   |   npx tsx tools/discipline/cli.ts <comando>
 */
import { spawnSync } from 'node:child_process'

interface CommandSpec {
  /** npm script al que despacha (reusa la capa de scripts existente, no reimplementa). */
  script: string
  /** Mensaje honesto de "siguiente accion" tras exito, para pasos cuya generacion es LLM. */
  note?: string
}

const COMMANDS: Record<string, CommandSpec> = {
  step1: {
    script: 'discipline:step1-prep',
    note:
      'Step 1 NO esta completo: esto solo preparo inputs, prompts y packet (deterministico).\n' +
      '  Para GENERAR el PRD corre el skill /discipline-step1 en tu agente,\n' +
      '  o usa `discipline step1 --with-llm` cuando la capa LLM este disponible.',
  },
  step2: {
    script: 'discipline:validate:architecture',
    note:
      'Step 2: esto VALIDO la arquitectura (deterministico). La generacion la produce\n' +
      '  el skill /discipline-step2 en tu agente (o --with-llm cuando este disponible).',
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
      'discipline - CLI de dos capas sobre los scripts discipline:* existentes.',
      '',
      'Uso: npm run discipline -- <comando> [args]   (o: npx tsx tools/discipline/cli.ts <comando>)',
      '',
      'Capa determinista (default, sin LLM, sin costo):',
      '  step1            Prepara inputs/prompts/packet del Paso 1 (NO genera el PRD)',
      '  step2            Valida la arquitectura del Paso 2',
      '  gate             Corre el gate del lane (npm run gate)',
      '  publish          Genera el release pack',
      '  validate         Valida integridad del pipeline',
      '  doctor           Diagnostico de salud del proyecto',
      '  status           Dashboard del pipeline',
      '  patch | assemble | progress | watch | cross-validate',
      '',
      'Capa LLM (opt-in, AUN NO IMPLEMENTADA):',
      '  <comando> --with-llm [--provider claude|codex]',
      '                   Ejecutaria el paso via LLM headless. Requiere provider',
      '                   configurado y confirmacion de costo. Hoy falla claro (exit 2).',
      '',
      'El sistema decide y controla; el agente ejecuta. Esta CLI solo despacha a los',
      'scripts existentes; no reimplementa logica ni oculta costo/dependencia.',
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
  console.error(`discipline: comando desconocido "${cmd}". Corre \`discipline help\`.`)
  process.exit(1)
}

// Capa 2 (seam): aun no implementada. Falla fuerte y claro, nunca exit 0.
if (argv.includes('--with-llm')) {
  console.error(
    [
      'discipline --with-llm: LLM execution is not implemented yet.',
      'This command would require provider config (--provider claude|codex) and explicit cost confirmation.',
      'Por ahora corre el skill correspondiente (p.ej. /discipline-step1) en tu agente.',
    ].join('\n'),
  )
  process.exit(2)
}

// --provider solo tiene sentido con la capa LLM (--with-llm). Sin ella, fallar claro
// en vez de descartar el flag en silencio: el usuario podria creer que invoco la LLM
// cuando en realidad corrio la capa determinista.
if (argv.includes('--provider')) {
  console.error(
    'discipline: --provider solo aplica con --with-llm (capa LLM). Quita --provider o agrega --with-llm.',
  )
  process.exit(1)
}

// Args restantes pasan tal cual al script base.
// (--with-llm y --provider ya cortaron arriba; no llegan aqui.)
const passthrough = argv.slice(1)

const spec = COMMANDS[cmd]
const npmArgs = ['run', spec.script, ...(passthrough.length ? ['--', ...passthrough] : [])]
const result = spawnSync('npm', npmArgs, { stdio: 'inherit', shell: true })

if (result.status === 0 && spec.note) {
  console.log(`\n[discipline ${cmd}] ${spec.note}`)
}

process.exit(result.status ?? 1)
