#!/usr/bin/env tsx
/**
 * audit-merge - deterministic step of the verification fan-out (7.2).
 *
 * Does not invoke an LLM. The /discipline-verify skill runs the 6 subagents (that part is
 * LLM, living in Claude Code), the parent agent writes each envelope to
 * `.discipline/audits/raw/<ts>/<agent>.json`, and this script:
 *   1. reads the envelopes,
 *   2. strips ```json fences defensively,
 *   3. validates each one against the contract `discipline.agent_audit.v1` (ajv),
 *   4. computes the global status (FAIL > WARN > PASS),
 *   5. merges findings and writes the report.
 *
 * It is ADVISORY: a global FAIL status does NOT fail the process (exit 0), unless
 * --strict is passed (advanced opt-in gate for CI). An envelope that does NOT match
 * the schema DOES fail (exit 2): it is contract drift, not an auditor opinion.
 *
 * Usage:
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
if (!args.rawDir) fail('missing --raw-dir <dir> (folder with <agent>.json envelopes)')
const rawDir = resolve(args.rawDir as string)
if (!existsSync(rawDir) || !statSync(rawDir).isDirectory()) fail(`--raw-dir does not exist or is not a folder: ${rawDir}`)

const files = readdirSync(rawDir)
  .filter((f) => f.toLowerCase().endsWith('.json'))
  .sort()
if (files.length === 0) fail(`no *.json envelopes in ${rawDir}`)

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
    errors.push(`${file}: invalid JSON (${(e as Error).message})`)
    continue
  }
  if (!validate(parsed)) {
    const detail = (validate.errors ?? [])
      .map((er) => `${er.instancePath || '/'} ${er.message}`)
      .join('; ')
    errors.push(`${file}: does not match discipline.agent_audit.v1 (${detail})`)
    continue
  }
  envelopes.push(parsed as Envelope)
}

if (errors.length > 0) {
  console.error('audit-merge: invalid envelopes (contract drift), not merging:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(2)
}

// Raw status from present envelopes: FAIL > WARN > PASS.
const rawStatus: 'PASS' | 'WARN' | 'FAIL' = envelopes.some((e) => e.status === 'FAIL')
  ? 'FAIL'
  : envelopes.some((e) => e.status === 'WARN')
    ? 'WARN'
    : 'PASS'

// Expected subagents that did NOT provide an envelope (omitted, not invented).
// A partial audit must not look like a clean PASS: raise the status to WARN
// at minimum and make it explicit in `missing_agents`.
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
    `${globalStatus}: ${envelopes.length} agents, ${counts.critical} critical, ${counts.moderate} moderate, ${counts.minor} minor` +
    (missing.length > 0 ? `, ${missing.length} missing expected` : '') +
    '.',
}

const outPath = args.out
  ? resolve(args.out)
  : resolve(join(rawDir, '..', '..', `${ts}-fanout.json`))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8')

// Readable summary (advisory).
console.log(`audit-merge: ${report.summary}`)
for (const a of report.agents) console.log(`  - ${a.agent}: ${a.status} (${a.finding_count} findings)`)
if (missing.length > 0) console.log(`  missing (expected, no envelope): ${missing.join(', ')}`)
console.log(`  report: ${outPath}`)
console.log('  (advisory: recommends, does not block. Use --strict to fail in CI if global=FAIL or expected agents are missing.)')

if (args.strict && (globalStatus === 'FAIL' || missing.length > 0)) process.exit(1)
process.exit(0)
