#!/usr/bin/env tsx
/**
 * audit-merge - paso DETERMINISTA del fan-out de verificacion (7.2).
 *
 * No invoca LLM. El skill /discipline-verify corre los 6 subagentes (eso si es
 * LLM, vive en Claude Code), el agente padre vuelca cada envelope a
 * `.discipline/audits/raw/<ts>/<agent>.json`, y este script:
 *   1. lee los envelopes,
 *   2. strippea fences ```json defensivamente,
 *   3. valida cada uno contra el contrato `discipline.agent_audit.v1` (ajv),
 *   4. computa el status global (FAIL > WARN > PASS),
 *   5. fusiona findings y escribe el reporte.
 *
 * Es ADVISORY: un status global FAIL NO hace fallar el proceso (exit 0), salvo
 * que se pase --strict (gate avanzado opt-in para CI). Un envelope que NO cumple
 * schema SI falla (exit 2): es drift del contrato, no una opinion del auditor.
 *
 * Uso:
 *   tsx tools/discipline/audit-merge.ts --raw-dir <dir> [--out <file>] [--strict]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import Ajv from 'ajv'

const ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'agent', 'status', 'blocking', 'findings', 'summary'],
  properties: {
    schema_version: { const: 'discipline.agent_audit.v1' },
    agent: { type: 'string', minLength: 1 },
    status: { enum: ['PASS', 'WARN', 'FAIL'] },
    blocking: { const: false },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'rule', 'location', 'detail', 'fix'],
        properties: {
          severity: { enum: ['critical', 'moderate', 'minor'] },
          rule: { type: 'string', minLength: 1 },
          location: { type: ['string', 'null'] },
          detail: { type: 'string', minLength: 1 },
          fix: { type: ['string', 'null'] },
        },
      },
    },
    summary: { type: 'string' },
  },
}

interface Finding {
  severity: 'critical' | 'moderate' | 'minor'
  rule: string
  location: string | null
  detail: string
  fix: string | null
}
interface Envelope {
  schema_version: string
  agent: string
  status: 'PASS' | 'WARN' | 'FAIL'
  blocking: false
  findings: Finding[]
  summary: string
}

function parseArgs(argv: string[]): { rawDir?: string; out?: string; strict: boolean; expected?: string[] } {
  const out: { rawDir?: string; out?: string; strict: boolean; expected?: string[] } = { strict: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--raw-dir') out.rawDir = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--strict') out.strict = true
    else if (a === '--expected')
      out.expected = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  }
  return out
}

/** Strip prose / ```json fences defensively and return the JSON object text. */
function extractJson(text: string): string {
  let t = text.trim()
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) t = fence[1].trim()
  if (!t.startsWith('{')) {
    const first = t.indexOf('{')
    const last = t.lastIndexOf('}')
    if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1)
  }
  return t
}

function fail(msg: string): never {
  console.error(`audit-merge: ${msg}`)
  process.exit(2)
}

const args = parseArgs(process.argv.slice(2))
if (!args.rawDir) fail('falta --raw-dir <dir> (carpeta con los envelopes <agent>.json)')
const rawDir = resolve(args.rawDir as string)
if (!existsSync(rawDir) || !statSync(rawDir).isDirectory()) fail(`--raw-dir no existe o no es carpeta: ${rawDir}`)

const files = readdirSync(rawDir)
  .filter((f) => f.toLowerCase().endsWith('.json'))
  .sort()
if (files.length === 0) fail(`no hay envelopes *.json en ${rawDir}`)

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(ENVELOPE_SCHEMA)

const envelopes: Envelope[] = []
const errors: string[] = []

for (const file of files) {
  const full = join(rawDir, file)
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(readFileSync(full, 'utf8')))
  } catch (e) {
    errors.push(`${file}: JSON invalido (${(e as Error).message})`)
    continue
  }
  if (!validate(parsed)) {
    const detail = (validate.errors ?? [])
      .map((er) => `${er.instancePath || '/'} ${er.message}`)
      .join('; ')
    errors.push(`${file}: no cumple discipline.agent_audit.v1 (${detail})`)
    continue
  }
  envelopes.push(parsed as Envelope)
}

if (errors.length > 0) {
  console.error('audit-merge: envelopes invalidos (drift del contrato), no se fusiona:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(2)
}

// Status crudo de los envelopes presentes: FAIL > WARN > PASS.
const rawStatus: 'PASS' | 'WARN' | 'FAIL' = envelopes.some((e) => e.status === 'FAIL')
  ? 'FAIL'
  : envelopes.some((e) => e.status === 'WARN')
    ? 'WARN'
    : 'PASS'

// Subagentes esperados que NO entregaron envelope (omitidos, no inventados).
// Una auditoria parcial no debe verse como PASS limpio: sube el status a WARN
// como minimo y queda explicito en `missing_agents`.
const present = new Set(envelopes.map((e) => e.agent))
const missing = (args.expected ?? []).filter((a) => !present.has(a))
const globalStatus: 'PASS' | 'WARN' | 'FAIL' =
  missing.length > 0 && rawStatus === 'PASS' ? 'WARN' : rawStatus

const mergedFindings = envelopes.flatMap((e) =>
  e.findings.map((f) => ({ agent: e.agent, ...f })),
)
const counts = {
  critical: mergedFindings.filter((f) => f.severity === 'critical').length,
  moderate: mergedFindings.filter((f) => f.severity === 'moderate').length,
  minor: mergedFindings.filter((f) => f.severity === 'minor').length,
}

const ts = basename(rawDir)
const report = {
  schema_version: 'discipline.audit_report.v1',
  generated_from: basename(rawDir),
  global_status: globalStatus,
  blocking: false,
  agents: envelopes.map((e) => ({ agent: e.agent, status: e.status, finding_count: e.findings.length })),
  missing_agents: missing,
  counts,
  findings: mergedFindings,
  summary:
    `${globalStatus}: ${envelopes.length} agentes, ${counts.critical} critical, ${counts.moderate} moderate, ${counts.minor} minor` +
    (missing.length > 0 ? `, ${missing.length} esperados faltantes` : '') +
    '.',
}

const outPath = args.out
  ? resolve(args.out)
  : resolve(join(rawDir, '..', '..', `${ts}-fanout.json`))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8')

// Resumen legible (advisory).
console.log(`audit-merge: ${report.summary}`)
for (const a of report.agents) console.log(`  - ${a.agent}: ${a.status} (${a.finding_count} findings)`)
if (missing.length > 0) console.log(`  faltantes (esperados, sin envelope): ${missing.join(', ')}`)
console.log(`  reporte: ${outPath}`)
console.log('  (advisory: recomienda, no bloquea. Usa --strict para fallar en CI si global=FAIL o faltan esperados.)')

if (args.strict && (globalStatus === 'FAIL' || missing.length > 0)) process.exit(1)
process.exit(0)
