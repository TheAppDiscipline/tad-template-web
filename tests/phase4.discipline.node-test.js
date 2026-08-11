import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

function runTsx(script, args = []) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

function runTsxAsync(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, script, ...args], { cwd: repoRoot })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function output(result) {
  return `${result.stdout}${result.stderr}`
}

function git(root, args) {
  const result = spawnSync('git', ['-c', `safe.directory=${root.replace(/\\/g, '/')}`, ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, output(result))
  return result.stdout.trim()
}

function write(root, relative, content) {
  const full = path.join(root, relative)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

function completePacket(id, status = 'ready', estimate = '- MAX_CHANGED_LINES: 100') {
  return [
    '---', 'schema: discipline.packet.step5', 'version: 2.0.0', `id: step5:${id}:T1`, `status: ${status}`,
    `slice: ${id}`, 'affected_surfaces:', '  - ui', 'required_gates:', '  - gate', '---', '',
    '# STEP_5_SLICE_PACKET', '', `SLICE: ${id}`, '',
    '## Goal', '- deliver the slice', '', '## Scope', '- one bounded change', '', '## Contracts', '- preserve the public contract', '',
    '## Provider Impact', '- APPLIES: no', '- RATIONALE: local-only change', '',
    '## AI Impact', '- APPLIES: no', '- RATIONALE: no model calls', '',
    '## Reachable States', '| State | Trigger | Committed effects | Returned result | Recovery |',
    '|---|---|---|---|---|', '| ready | command | metric record | success | delete reviewed bad record |', '',
    '## Acceptance Criteria', '| ID | Setup | Action | Observable result | Negative control |',
    '|---|---|---|---|---|', '| AC1 | clean repo | run command | record exists | malformed estimate fails |', '',
    '## Falsifiability', '- METHOD: mutation', '- EVIDENCE: remove MAX_CHANGED_LINES and the command fails', '',
    '## Files to touch', '- tools/discipline', '', '## Deployment Compatibility', '- no runtime change', '',
    '## Manual Verification', '- inspect JSONL', '', '## Estimate', estimate, '',
  ].join('\n')
}

function completionPacket(id, outcome = 'done', gate = 'passed') {
  return [
    '# SLICE_COMPLETION_PACKET', `SLICE: ${id}`, '', '### Outcome', `- ${outcome}`, '',
    '### Gates passed', `- GATE_STATE: ${gate}`, '',
  ].join('\n')
}

function signedMetric(slice = '1', changedLines = 42) {
  const unsigned = {
    schema: 'discipline.slice_metric.v1', recorded_at: '2026-08-11T00:00:00.000Z', slice,
    base: { requested: 'main', resolved: 'a'.repeat(40) },
    packet: { file: `.discipline/packets/STEP_5_SLICE_PACKET_${slice}.md`, sha256: 'b'.repeat(64) },
    affected_surfaces: ['ui'],
    estimate: { raw: '- MAX_CHANGED_LINES: 100', max_changed_lines: 100, split_decision: null, duplicate_metrics: null },
    actual: {
      files: 1, additions: changedLines, deletions: 0, changed_lines: changedLines, binary_files: 0,
      paths: ['src/app.ts'], categories: {
        production: { files: 1, additions: changedLines, deletions: 0, changed_lines: changedLines, binary_files: 0 },
        tests: { files: 0, additions: 0, deletions: 0, changed_lines: 0, binary_files: 0 },
        'fixtures-config': { files: 0, additions: 0, deletions: 0, changed_lines: 0, binary_files: 0 },
        documentation: { files: 0, additions: 0, deletions: 0, changed_lines: 0, binary_files: 0 },
      },
    },
  }
  return { ...unsigned, signature: crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') }
}

function scaffold(root, slices = [['13', 'ready']]) {
  write(root, 'discipline.md', '# discipline.md\n')
  write(root, 'findings.md', '# findings.md\n')
  write(root, 'findings_archive.md', '# findings_archive.md\n\n## Archived Findings\n- (none)\n')
  write(root, 'task_plan_archive.md', '# task_plan_archive.md\n\n## Archived Slices\n- (none)\n')
  write(root, 'progress.md', '# progress.md\n\n## Current Status\n- Blockers: none\n')
  const rows = slices.map(([id, status]) => `| ${id} | ${status} |`).join('\n')
  const sections = slices.map(([id, status]) => `## Slice ${id} - Slice ${id}\n- status: ${status}\n`).join('\n')
  write(root, 'task_plan.md', `# task_plan.md\n\n## 4) Ready Slices\n| Slice | Status |\n|---|---|\n${rows}\n\n${sections}`)
  fs.mkdirSync(path.join(root, '.discipline', 'packets'), { recursive: true })
}

test('metrics records categorized numstat, fails above the maximum, and refuses undeclared duplicates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-metrics-'))
  scaffold(root)
  write(root, '.discipline/packets/STEP_5_SLICE_PACKET_13.md', completePacket('13', 'ready', '- MAX_CHANGED_LINES: 3'))
  write(root, 'src/app.ts', 'export const base = true\n')
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'tests@example.invalid'])
  git(root, ['config', 'user.name', 'Discipline Tests'])
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'baseline'])
  const base = git(root, ['rev-parse', 'HEAD'])

  write(root, 'src/app.ts', 'export const base = false\nexport const added = true\n')
  write(root, 'tests/app.spec.ts', 'test one\ntest two\n')
  write(root, 'docs/decision.md', '# Decision\n')
  write(root, 'vite.config.ts', 'export default {}\n')

  const refused = runTsx('tools/discipline/metrics.ts', ['--slice', '13', '--base', base, '--project-dir', root])
  assert.notEqual(refused.status, 0)
  assert.match(output(refused), /SPLIT_DECISION: split or SPLIT_DECISION: exception-approved/)
  assert.equal(fs.existsSync(path.join(root, '.discipline', 'metrics', 'slices.jsonl')), false)

  write(root, '.discipline/packets/STEP_5_SLICE_PACKET_13.md', completePacket('13', 'ready', [
    '- MAX_CHANGED_LINES: 3', '- SPLIT_DECISION: exception-approved',
  ].join('\n')))
  const recorded = runTsx('tools/discipline/metrics.ts', ['--slice', '13', '--base', base, '--recorded-at', '2026-08-11T00:00:00.000Z', '--project-dir', root])
  assert.equal(recorded.status, 0, output(recorded))
  const record = JSON.parse(fs.readFileSync(path.join(root, '.discipline', 'metrics', 'slices.jsonl'), 'utf8').trim())
  assert.equal(record.schema, 'discipline.slice_metric.v1')
  assert.ok(record.actual.categories.production.files >= 1)
  assert.equal(record.actual.categories.tests.files, 1)
  assert.ok(record.actual.categories.documentation.files >= 1)
  assert.equal(record.actual.categories['fixtures-config'].files, 1)
  assert.match(record.signature, /^[a-f0-9]{64}$/)

  const duplicate = runTsx('tools/discipline/metrics.ts', ['--slice', '13', '--base', base, '--project-dir', root])
  assert.notEqual(duplicate.status, 0)
  assert.match(output(duplicate), /DUPLICATE_METRICS: allowed/)

  write(root, '.discipline/packets/STEP_5_SLICE_PACKET_13.md', completePacket('13', 'ready', [
    '- MAX_CHANGED_LINES: 3', '- SPLIT_DECISION: exception-approved', '- DUPLICATE_METRICS: allowed',
  ].join('\n')))
  const declaredDuplicate = runTsx('tools/discipline/metrics.ts', ['--slice', '13', '--base', base, '--recorded-at', '2026-08-11T01:00:00.000Z', '--project-dir', root])
  assert.equal(declaredDuplicate.status, 0, output(declaredDuplicate))
  const records = fs.readFileSync(path.join(root, '.discipline', 'metrics', 'slices.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 2)
  assert.equal(records[1].actual.paths.includes('.discipline/metrics/slices.jsonl'), false)
})

test('metrics classifies real Web, Mobile, Desktop, Extension and CI configuration before test parents', () => {
  const paths = [
    'app.json', 'eas.json', 'src-tauri/tauri.conf.json', 'manifest.json',
    '.github/workflows/ci.yml', '.env.example', 'tests/fixtures/data.json',
  ]
  const source = `import { classifyMetricPath } from './tools/discipline/lib/metrics.ts'; console.log(JSON.stringify(${JSON.stringify(paths)}.map((file) => [file, classifyMetricPath(file)])))`
  const result = spawnSync(process.execPath, [tsxCli, '-e', source], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, output(result))
  assert.deepEqual(JSON.parse(result.stdout), paths.map((file) => [file, 'fixtures-config']))
})

test('metrics verifies signatures and serializes concurrent duplicate checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-metrics-lock-'))
  scaffold(root)
  write(root, '.discipline/packets/STEP_5_SLICE_PACKET_13.md', completePacket('13'))
  write(root, 'src/app.ts', 'export const base = true\n')
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'tests@example.invalid'])
  git(root, ['config', 'user.name', 'Discipline Tests'])
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'baseline'])
  const base = git(root, ['rev-parse', 'HEAD'])
  write(root, 'src/app.ts', 'export const base = false\n')

  const args = ['--slice', '13', '--base', base, '--project-dir', root]
  const attempts = await Promise.all([runTsxAsync('tools/discipline/metrics.ts', args), runTsxAsync('tools/discipline/metrics.ts', args)])
  assert.equal(attempts.filter((attempt) => attempt.status === 0).length, 1, attempts.map(output).join('\n'))
  const file = path.join(root, '.discipline', 'metrics', 'slices.jsonl')
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1)

  const record = JSON.parse(fs.readFileSync(file, 'utf8').trim())
  record.actual.changed_lines++
  write(root, '.discipline/metrics/slices.jsonl', `${JSON.stringify(record)}\n`)
  const state = runTsx('tools/discipline/state-view.ts', ['--json', '--project-dir', root])
  assert.equal(state.status, 0, output(state))
  assert.match(JSON.parse(state.stdout).blockers.join('\n'), /signature mismatch/)
})

test('state-view is byte deterministic and --json exposes the same slice, gate, metric, and blocker state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-state-'))
  scaffold(root, [['1', 'ready'], ['2', 'in-progress'], ['3', 'done']])
  for (const [id, status] of [['1', 'ready'], ['2', 'draft'], ['3', 'consumed']]) {
    write(root, `.discipline/packets/STEP_5_SLICE_PACKET_${id}.md`, completePacket(id, status))
  }
  write(root, '.discipline/packets/SLICE_COMPLETION_PACKET_3.md', completionPacket('3'))
  write(root, 'progress.md', [
    '# progress.md', '', '## Current Status', '- Blockers: none', '', '---',
    '### 2026-08-11 — Slice 3', '- **Status:** done', '- **Gates:** yes', '',
  ].join('\n'))
  const metric = signedMetric()
  write(root, '.discipline/metrics/slices.jsonl', `${JSON.stringify(metric)}\n`)
  write(root, '.discipline/gate-report.json', JSON.stringify({
    schema: 'discipline.gate_report.v2', ts: '2026-08-11T00:00:00.000Z', mode: 'changed', passed: true,
    failed_checks: [], files: ['src/app.ts'], surfaces: { used: ['ui'] },
  }))

  const first = runTsx('tools/discipline/state-view.ts', ['--project-dir', root])
  assert.equal(first.status, 0, output(first))
  const viewPath = path.join(root, '.discipline', 'views', 'current-state.md')
  const firstBytes = fs.readFileSync(viewPath)
  const second = runTsx('tools/discipline/state-view.ts', ['--project-dir', root])
  assert.equal(second.status, 0, output(second))
  assert.deepEqual(fs.readFileSync(viewPath), firstBytes)

  const jsonRun = runTsx('tools/discipline/state-view.ts', ['--json', '--project-dir', root])
  assert.equal(jsonRun.status, 0, output(jsonRun))
  const state = JSON.parse(jsonRun.stdout)
  assert.deepEqual(state.slices.map((slice) => [slice.id, slice.status]), [['1', 'ready'], ['2', 'in-progress'], ['3', 'consumed']])
  assert.equal(state.slices[0].packet.required_gates[0], 'gate')
  assert.equal(state.slices[0].latest_metric.changed_lines, 42)
  assert.deepEqual(state.slices[0].latest_metric.affected_surfaces, ['ui'])
  assert.equal(state.gate.passed, true)
  assert.deepEqual(state.gate.surfaces, ['ui'])
  assert.deepEqual(state.blockers, [])
  const cliJson = runTsx('tools/discipline/cli.ts', ['state-view', '--json', '--project-dir', root])
  assert.equal(cliJson.status, 0, output(cliJson))
  assert.equal(JSON.parse(cliJson.stdout).schema, 'discipline.state_view.v1')
  const npmJson = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `npm.cmd run --silent discipline -- state-view --json --project-dir "${root}"`], { cwd: repoRoot, encoding: 'utf8' })
    : spawnSync('npm', ['run', '--silent', 'discipline', '--', 'state-view', '--json', '--project-dir', root], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(npmJson.status, 0, output(npmJson))
  assert.equal(JSON.parse(npmJson.stdout).schema, 'discipline.state_view.v1')
  const markdown = fs.readFileSync(viewPath, 'utf8')
  assert.match(markdown, /## Ready[\s\S]*42\/100 lines/)
  assert.match(markdown, /## In progress/)
  assert.match(markdown, /## Consumed/)
})

test('state-view refuses partial consumption and expands multiline Open Errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-state-negative-'))
  scaffold(root, [['4', 'done'], ['5', 'done']])
  write(root, '.discipline/packets/STEP_5_SLICE_PACKET_4.md', completePacket('4', 'ready'))
  write(root, '.discipline/packets/STEP_5_SLICE_PACKET_5.md', completePacket('5', 'consumed'))
  write(root, '.discipline/packets/SLICE_COMPLETION_PACKET_4.md', completionPacket('4'))
  write(root, 'progress.md', [
    '# progress.md', '', '## Current Status', '- Blockers: see Open Errors', '',
    '## Open Errors', '- First blocker with evidence', '  continued on the next line',
    '- Second blocker', '',
  ].join('\n'))
  const state = runTsx('tools/discipline/state-view.ts', ['--json', '--project-dir', root])
  assert.equal(state.status, 0, output(state))
  const parsed = JSON.parse(state.stdout)
  assert.deepEqual(parsed.slices.map((slice) => [slice.id, slice.status]), [['4', 'blocked'], ['5', 'blocked']])
  assert.ok(parsed.blockers.includes('First blocker with evidence continued on the next line'))
  assert.ok(parsed.blockers.includes('Second blocker'))
  assert.match(parsed.blockers.join('\n'), /Slice 4 has an incomplete consumption transition: packet=ready, completion=terminal-green, progress=not-recorded/)
  assert.match(parsed.blockers.join('\n'), /Slice 5 has an incomplete consumption transition: packet=consumed/)
})

test('Step 4 producer declares the metrics contract and v2 refuses a prose-only Estimate', () => {
  const skill = fs.readFileSync(path.join(repoRoot, '.claude', 'skills', 'discipline-step4', 'SKILL.md'), 'utf8')
  const templateEstimate = skill.match(/## Estimate\r?\n([\s\S]*?)\r?\n## UI Reference/)?.[1] ?? ''
  assert.match(templateEstimate, /MAX_CHANGED_LINES: <positive integer/)
  assert.match(templateEstimate, /BASIS:/)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-step4-metrics-'))
  scaffold(root)
  write(root, '.discipline/packets/STEP_5_SLICE_PACKET_13.md', completePacket('13', 'ready', '- about 40 production lines'))
  const validation = runTsx('tools/discipline/assemble-paste-ready.ts', ['--step', '5', '--slice', '13', '--project-dir', root])
  assert.notEqual(validation.status, 0)
  assert.match(output(validation), /MAX_CHANGED_LINES: <positive integer>/)
})

test('document growth reports the 2,000-line threshold and Step 4 receives historical metrics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-docs-'))
  scaffold(root)
  write(root, 'task_plan.md', `${fs.readFileSync(path.join(root, 'task_plan.md'), 'utf8')}\n${Array.from({ length: 2001 }, (_, i) => `history ${i}`).join('\n')}`)
  write(root, '.discipline/metrics/slices.jsonl', `${JSON.stringify(signedMetric('12', 12))}\n`)
  write(root, '.discipline/packets/SLICE_COMPLETION_PACKET.md', '# SLICE_COMPLETION_PACKET\n')

  const state = runTsx('tools/discipline/state-view.ts', ['--json', '--project-dir', root])
  assert.equal(state.status, 0, output(state))
  const parsed = JSON.parse(state.stdout)
  assert.equal(parsed.documents.find((doc) => doc.file === 'task_plan.md').warning, 'normal')

  const assembled = runTsx('tools/discipline/assemble-paste-ready.ts', ['--step', '4-reentry', '--project-dir', root])
  assert.equal(assembled.status, 0, output(assembled))
  const handoff = fs.readFileSync(path.join(root, '.discipline', 'paste-ready', 'step-4-reentry.md'), 'utf8')
  assert.match(handoff, /\.discipline\/metrics\/slices\.jsonl \(context\)/)
  assert.match(handoff, /discipline\.slice_metric\.v1/)
})
