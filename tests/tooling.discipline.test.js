import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decide as decideDbTypes, parseBackendProvider } from '../tools/check_db_types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

function runTsx(script, args = []) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  })
}

function getOutput(result) {
  return `${result.stdout}${result.stderr}`
}

function createDisciplineProject(packetMap = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-tooling-'))

  for (const fileName of ['discipline.md', 'task_plan.md', 'findings.md', 'progress.md']) {
    fs.copyFileSync(path.join(repoRoot, fileName), path.join(projectRoot, fileName))
  }

  fs.mkdirSync(path.join(projectRoot, '.discipline', 'packets'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.discipline', 'patches', 'pending'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.discipline', 'patches', 'applied'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.discipline', 'paste-ready'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, '.discipline', 'prompts'), { recursive: true })

  for (const [fileName, content] of Object.entries(packetMap)) {
    fs.writeFileSync(path.join(projectRoot, '.discipline', 'packets', fileName), content, 'utf8')
  }

  // F3-E: normalize the fixture to LITE so the bundled tooling tests are independent of
  // whatever PROFILE the project's discipline.md is in. A buyer on PROFILE=LAUNCH/PROD
  // would otherwise trip Gate D (scorecard required) in tests that don't set a profile.
  setProfile(projectRoot, 'LITE')

  return projectRoot
}

function setProfile(projectRoot, profile) {
  const disciplinePath = path.join(projectRoot, 'discipline.md')
  const content = fs.readFileSync(disciplinePath, 'utf8')
  fs.writeFileSync(
    disciplinePath,
    content.replace(/^- PROFILE:\s*.*$/m, `- PROFILE: ${profile}`),
    'utf8',
  )
}

function writeScorecard(projectRoot, content) {
  fs.writeFileSync(path.join(projectRoot, '.discipline', 'scorecard.yaml'), content, 'utf8')
}

test('discipline assemble accepts Step 0a and writes paso-0a-input.md', () => {
  const projectRoot = createDisciplineProject()
  const result = runTsx('tools/discipline/assemble-paste-ready.ts', ['--step', '0a', '--project-dir', projectRoot])

  assert.equal(result.status, 0, getOutput(result))
  assert.equal(fs.existsSync(path.join(projectRoot, '.discipline', 'paste-ready', 'paso-0a-input.md')), true)
  assert.equal(fs.existsSync(path.join(projectRoot, '.discipline', 'paste-ready', 'paso-0.1-input.md')), false)
})

test('discipline assemble builds feedback and hardening handoffs', () => {
  const projectRoot = createDisciplineProject({
    'POST_DEPLOY_FEEDBACK_PACKET.md': `# POST_DEPLOY_FEEDBACK_PACKET\n\nSTATUS: ready\nSOURCE_STEP: Paso 6\n\n## Recommended branch\n- Paso 4 feedback loop\n`,
    'PROD_HARDENING_PACKET.md': `# PROD_HARDENING_PACKET\n\nSTATUS: ready\nSOURCE_STEP: Paso 7\n\n## Target phase\n- PROD-1\n\n## Mandatory slices\n- Auth hardening\n`,
  })

  const feedback = runTsx('tools/discipline/assemble-paste-ready.ts', ['--step', '4-feedback', '--project-dir', projectRoot])
  assert.equal(feedback.status, 0, getOutput(feedback))

  const feedbackOutput = fs.readFileSync(path.join(projectRoot, '.discipline', 'paste-ready', 'paso-4-feedback.md'), 'utf8')
  assert.match(feedbackOutput, /POST_DEPLOY_FEEDBACK_PACKET/)
  assert.match(feedbackOutput, /discipline.md \(contexto\)/)

  const hardening = runTsx('tools/discipline/assemble-paste-ready.ts', ['--step', '4-hardening', '--project-dir', projectRoot])
  assert.equal(hardening.status, 0, getOutput(hardening))

  const hardeningOutput = fs.readFileSync(path.join(projectRoot, '.discipline', 'paste-ready', 'paso-4-hardening.md'), 'utf8')
  assert.match(hardeningOutput, /PROD_HARDENING_PACKET/)
  assert.match(hardeningOutput, /findings\.md \(contexto\)/)
})

test('discipline validate rejects an incomplete deploy readiness packet', () => {
  const projectRoot = createDisciplineProject({
    'DEPLOY_READINESS_PACKET.md': `# DEPLOY_READINESS_PACKET\n\nSTATUS: ready\nSOURCE_STEP: Paso 5\n\n## Release scope\n- Candidate build\n`,
  })

  const result = runTsx('tools/discipline/validate-discipline.ts', ['--project-dir', projectRoot])

  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /DEPLOY_READINESS_PACKET incompleto: falta Platform checks/)
})

test('discipline validate rejects an incomplete slice completion packet', () => {
  const projectRoot = createDisciplineProject({
    'SLICE_COMPLETION_PACKET.md': `# SLICE_COMPLETION_PACKET\n\nSTATUS: ready\nSOURCE_STEP: Paso 5\n\n## Slice\n- Slice 1\n\n## Outcome\n- done\n`,
  })

  const result = runTsx('tools/discipline/validate-discipline.ts', ['--project-dir', projectRoot])

  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /SLICE_COMPLETION_PACKET incompleto: falta Deploy signal/)
})

test('discipline validate accepts complete post-deploy and hardening packets', () => {
  const projectRoot = createDisciplineProject({
    'POST_DEPLOY_FEEDBACK_PACKET.md': `# POST_DEPLOY_FEEDBACK_PACKET\n\nSTATUS: ready\nSOURCE_STEP: Paso 6\n\n## Recommended branch\n- Paso 7 productizacion\n`,
    'PROD_HARDENING_PACKET.md': `# PROD_HARDENING_PACKET\n\nSTATUS: ready\nSOURCE_STEP: Paso 7\n\n## Target phase\n- PROD-1\n\n## Mandatory slices\n- Billing\n`,
  })

  const result = runTsx('tools/discipline/validate-discipline.ts', ['--project-dir', projectRoot])

  assert.equal(result.status, 0, getOutput(result))
  assert.match(getOutput(result), /Validacion OK/)
})

test('scorecard launch rejects critical done items without evidence', () => {
  const projectRoot = createDisciplineProject()
  writeScorecard(projectRoot, `meta:
  project: Fixture
  profile_target: LAUNCH
launch:
  critical:
    - id: L1
      name: Smoke test
      status: done
      severity: CRITICAL
`)

  const result = runTsx('tools/discipline/validate-scorecard.ts', ['--mode', 'launch', '--project-dir', projectRoot])

  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /done without evidence \(CRITICAL\)/)
})

test('scorecard launch warns on recommended done items without evidence', () => {
  const projectRoot = createDisciplineProject()
  writeScorecard(projectRoot, `meta:
  project: Fixture
  profile_target: LAUNCH
launch:
  critical:
    - id: L1
      name: Smoke test
      status: done
      severity: CRITICAL
      evidence: https://example.com/evidence/smoke.md
  recommended:
    - id: R1
      name: Analytics baseline
      status: done
      severity: RECOMMENDED
`)

  const result = runTsx('tools/discipline/validate-scorecard.ts', ['--mode', 'launch', '--project-dir', projectRoot])

  assert.equal(result.status, 0, getOutput(result))
  assert.match(getOutput(result), /done without evidence \(RECOMMENDED\)/)
})

test('discipline validate triggers Gate D for PROFILE=LAUNCH', () => {
  const projectRoot = createDisciplineProject()
  setProfile(projectRoot, 'LAUNCH')
  writeScorecard(projectRoot, `meta:
  project: Fixture
  profile_target: LAUNCH
launch:
  critical:
    - id: L1
      name: Smoke test
      status: done
      severity: CRITICAL
`)

  const result = runTsx('tools/discipline/validate-discipline.ts', ['--project-dir', projectRoot])

  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /npm run discipline:validate:launch/)
  assert.match(getOutput(result), /done without evidence \(CRITICAL\)/)
})

test('discipline validate triggers Gate E for PROFILE=PROD', () => {
  const projectRoot = createDisciplineProject()
  setProfile(projectRoot, 'PROD')
  writeScorecard(projectRoot, `meta:
  project: Fixture
  profile_target: LAUNCH
launch:
  critical:
    - id: L1
      name: Smoke test
      status: done
      severity: CRITICAL
      evidence: https://example.com/evidence/smoke.md
prod:
  critical:
    - id: P1
      name: Rollback tested
      status: done
      severity: CRITICAL
      evidence: https://example.com/evidence/rollback.md
`)

  const result = runTsx('tools/discipline/validate-discipline.ts', ['--project-dir', projectRoot])

  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /npm run discipline:validate:prod/)
  assert.match(getOutput(result), /meta\.profile_target must be PROD/)
})

test('discipline validate does not require scorecard for PROFILE=LITE', () => {
  const projectRoot = createDisciplineProject()
  setProfile(projectRoot, 'LITE')

  const result = runTsx('tools/discipline/validate-discipline.ts', ['--project-dir', projectRoot])

  assert.equal(result.status, 0, getOutput(result))
})

// Patch block tests, los 4 modos: replace_section, replace_block, insert_after, append.
// Cada modo: 1 happy path + 1 edge case. 8 tests total.

function writePatch(projectRoot, name, body) {
  fs.writeFileSync(
    path.join(projectRoot, '.discipline', 'patches', 'pending', `${name}.md`),
    body,
    'utf8'
  )
}

test('apply-patch replace_section keeps heading and replaces content', () => {
  const projectRoot = createDisciplineProject()
  writePatch(projectRoot, 'replace-section-happy', `# Test Replace Section
TARGET_FILE: discipline.md
PATCH_MODE: replace_section
ANCHOR: ## 5) Sync Rules

### CONTENT
SYNC_RULE_REPLACED_OK
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.equal(result.status, 0, getOutput(result))

  const disciplineMd = fs.readFileSync(path.join(projectRoot, 'discipline.md'), 'utf8')
  // Heading conservado, contenido reemplazado.
  assert.match(disciplineMd, /## 5\) Sync Rules/)
  assert.match(disciplineMd, /SYNC_RULE_REPLACED_OK/)
})

test('apply-patch replace_section fails when anchor does not exist', () => {
  const projectRoot = createDisciplineProject()
  writePatch(projectRoot, 'replace-section-edge', `# Test Anchor Missing
TARGET_FILE: discipline.md
PATCH_MODE: replace_section
ANCHOR: ## 999) This Anchor Does Not Exist

### CONTENT
should not be applied
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /Anchor not found/)
})

test('apply-patch replace_block replaces heading and content', () => {
  const projectRoot = createDisciplineProject()
  writePatch(projectRoot, 'replace-block-happy', `# Test Replace Block
TARGET_FILE: task_plan.md
PATCH_MODE: replace_block
ANCHOR: ## 5) Deferred / Later

### CONTENT
## 5) Deferred / Later (renamed)
- new deferred items here
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.equal(result.status, 0, getOutput(result))

  const taskPlan = fs.readFileSync(path.join(projectRoot, 'task_plan.md'), 'utf8')
  assert.match(taskPlan, /## 5\) Deferred \/ Later \(renamed\)/)
  assert.match(taskPlan, /new deferred items here/)
})

test('apply-patch replace_block fails when target file does not exist', () => {
  const projectRoot = createDisciplineProject()
  // Borrar findings.md y luego intentar parchearlo.
  fs.unlinkSync(path.join(projectRoot, 'findings.md'))

  writePatch(projectRoot, 'replace-block-edge', `# Test Target Missing
TARGET_FILE: findings.md
PATCH_MODE: replace_block
ANCHOR: ## Decisions

### CONTENT
## Decisions
- replaced
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /Target file not found|findings\.md/)
})

test('apply-patch insert_after adds content after the section', () => {
  const projectRoot = createDisciplineProject()
  writePatch(projectRoot, 'insert-after-happy', `# Test Insert After
TARGET_FILE: findings.md
PATCH_MODE: insert_after
ANCHOR: ## Decisions

### CONTENT
## New Decision Section
- inserted after Decisions
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.equal(result.status, 0, getOutput(result))

  const findings = fs.readFileSync(path.join(projectRoot, 'findings.md'), 'utf8')
  assert.match(findings, /## Decisions/)
  assert.match(findings, /## New Decision Section/)
  assert.match(findings, /inserted after Decisions/)
  // El nuevo bloque aparece despues de Decisions y antes de la siguiente seccion canonica.
  const decisionsIdx = findings.indexOf('## Decisions')
  const newSectionIdx = findings.indexOf('## New Decision Section')
  assert.ok(newSectionIdx > decisionsIdx, 'inserted block should be after Decisions')
})

test('apply-patch insert_after fails when patch mode value is invalid', () => {
  const projectRoot = createDisciplineProject()
  writePatch(projectRoot, 'insert-after-edge', `# Test Invalid Mode
TARGET_FILE: findings.md
PATCH_MODE: not_a_real_mode
ANCHOR: ## Decisions

### CONTENT
should not be applied
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /PATCH_MODE/)
})

test('apply-patch append adds content to end of the section', () => {
  const projectRoot = createDisciplineProject()
  writePatch(projectRoot, 'append-happy', `# Test Append
TARGET_FILE: progress.md
PATCH_MODE: append
ANCHOR: ## Last Completed Slices

### CONTENT
- Slice 99: appended via patch test
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.equal(result.status, 0, getOutput(result))

  const progress = fs.readFileSync(path.join(projectRoot, 'progress.md'), 'utf8')
  assert.match(progress, /## Last Completed Slices/)
  assert.match(progress, /Slice 99: appended via patch test/)
})

test('apply-patch append fails on disallowed target file', () => {
  const projectRoot = createDisciplineProject()
  writePatch(projectRoot, 'append-edge', `# Test Disallowed Target
TARGET_FILE: package.json
PATCH_MODE: append
ANCHOR: ## anything

### CONTENT
should not be applied
`)

  const result = runTsx('tools/discipline/apply-patch.ts', ['--project-dir', projectRoot])
  assert.notEqual(result.status, 0)
  assert.match(getOutput(result), /TARGET_FILE not allowed/)
})

function pathToImport(absPath) {
  // Convierte ruta absoluta Windows a URL file:// que tsx pueda resolver.
  return 'file:///' + absPath.replace(/\\/g, '/').replace(/^\//, '')
}

// QW-2 audit, log-run.ts ya no auto-ejecuta cuando se importa, solo cuando se invoca como CLI.
// Eso permite a watch.ts importar logRun sin disparar process.exit en startup.
test('log-run.ts is importable without side effects and appends to run-log.md', () => {
  const projectRoot = createDisciplineProject()
  const importTester = path.join(projectRoot, 'import-tester.mjs')
  fs.writeFileSync(
    importTester,
    `import { logRun } from '${pathToImport(path.join(repoRoot, 'tools', 'discipline', 'log-run.ts'))}'
console.log('imported OK:', typeof logRun)
await logRun(${JSON.stringify(projectRoot)}, { step: '5', tool: 'test', notes: 'auto-log smoke' })
console.log('logRun call OK')
`,
    'utf8'
  )

  const result = spawnSync(process.execPath, [tsxCli, importTester], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, getOutput(result))
  assert.match(getOutput(result), /imported OK: function/)
  assert.match(getOutput(result), /logRun call OK/)

  const logContent = fs.readFileSync(path.join(projectRoot, '.discipline', 'run-log.md'), 'utf8')
  assert.match(logContent, /\| Step 5 \| test \|/)
  assert.match(logContent, /auto-log smoke/)
})

// QW-2 audit followups, watch.ts must (a) detect the right next step from packets
// and (b) auto-log every processed packet to run-log.md.
test('watch detectNext maps packet types to expected next step', () => {
  const projectRoot = createDisciplineProject()
  const tester = path.join(projectRoot, 'detect-next-tester.mjs')
  const watchUrl = pathToImport(path.join(repoRoot, 'tools', 'discipline', 'watch.ts'))

  fs.writeFileSync(
    tester,
    [
      `import { detectNext } from '${watchUrl}'`,
      `import fs from 'node:fs'`,
      `import path from 'node:path'`,
      ``,
      `const root = ${JSON.stringify(projectRoot)}`,
      `const dir = path.join(root, '.discipline', 'packets')`,
      ``,
      `function clear() { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)) }`,
      `function write(name, body = '') { fs.writeFileSync(path.join(dir, name), body, 'utf-8') }`,
      ``,
      `const out = {}`,
      `clear(); write('STEP_2_ARCHITECTURE_PACKET.md'); out['step2-only'] = detectNext(root)`,
      `clear(); write('STEP_4_EXECUTION_PACKET.md'); out['step4-input'] = detectNext(root)`,
      `clear(); write('STEP_5_SLICE_PACKET.md'); out['step5-input'] = detectNext(root)`,
      `clear(); write('SLICE_COMPLETION_PACKET.md'); out['slice-completion'] = detectNext(root)`,
      `clear(); write('DEPLOY_READINESS_PACKET.md'); out['deploy-ready'] = detectNext(root)`,
      `clear(); write('POST_DEPLOY_FEEDBACK_PACKET.md', '## Recommended branch\\n- Paso 4 feedback loop'); out['feedback-paso4'] = detectNext(root)`,
      `clear(); write('POST_DEPLOY_FEEDBACK_PACKET.md', '## Recommended branch\\n- Paso 7 productizacion'); out['feedback-paso7'] = detectNext(root)`,
      `clear(); write('PROD_HARDENING_PACKET.md'); out['hardening'] = detectNext(root)`,
      `clear(); out['empty'] = detectNext(root)`,
      `console.log('RESULT=' + JSON.stringify(out))`,
    ].join('\n'),
    'utf8'
  )

  const result = spawnSync(process.execPath, [tsxCli, tester], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, getOutput(result))
  const match = getOutput(result).match(/RESULT=(\{.*\})/)
  assert.ok(match, `expected RESULT line in output, got: ${getOutput(result)}`)
  const out = JSON.parse(match[1])

  assert.equal(out['step2-only'], '2')
  assert.equal(out['step4-input'], '4')
  assert.equal(out['step5-input'], '5')
  assert.equal(out['slice-completion'], '4-reentry')
  assert.equal(out['deploy-ready'], '6')
  assert.equal(out['feedback-paso4'], '4-feedback')
  assert.equal(out['feedback-paso7'], '7')
  assert.equal(out['hardening'], '4-hardening')
  assert.equal(out['empty'], null)
})

test('watch handlePacket auto-logs every packet to run-log.md', () => {
  const projectRoot = createDisciplineProject()
  // Unrecognized packet name keeps detectNext null, so no assemble/clipboard/openTool
  // side effects fire. The auto-log path must still record the run.
  const packetName = 'CUSTOM_TEST_PACKET.md'
  const packetPath = path.join(projectRoot, '.discipline', 'packets', packetName)
  fs.writeFileSync(packetPath, '# CUSTOM\nbody\n', 'utf-8')

  const tester = path.join(projectRoot, 'handle-packet-tester.mjs')
  const watchUrl = pathToImport(path.join(repoRoot, 'tools', 'discipline', 'watch.ts'))

  fs.writeFileSync(
    tester,
    [
      `import { handlePacket } from '${watchUrl}'`,
      `await handlePacket(${JSON.stringify(projectRoot)}, ${JSON.stringify(packetPath)})`,
      `console.log('handlePacket OK')`,
    ].join('\n'),
    'utf8'
  )

  const result = spawnSync(process.execPath, [tsxCli, tester], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  })

  assert.equal(result.status, 0, getOutput(result))
  assert.match(getOutput(result), /handlePacket OK/)

  const logPath = path.join(projectRoot, '.discipline', 'run-log.md')
  assert.ok(fs.existsSync(logPath), 'run-log.md must be created by handlePacket')
  const log = fs.readFileSync(logPath, 'utf8')
  assert.match(log, /\| Step watch \| discipline:watch \|/)
  assert.match(log, /CUSTOM_TEST_PACKET\.md/)
  assert.match(log, /no-op/)
})

test('discipline:watch --once is healthy on a fresh project (no packets)', () => {
  // Proyecto recien clonado: directorio temporal SIN .discipline/.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-watch-once-'))

  const result = runTsx('tools/discipline/watch.ts', ['--once', '--project-dir', projectRoot])

  // 1) Sale 0: no truena en un proyecto sin packets (el bug historico).
  assert.equal(result.status, 0, getOutput(result))
  // 2) Reporta salud y no se queda observando.
  assert.match(getOutput(result), /watcher healthy/)
  // 3) Crea .discipline/packets/ si faltaba.
  assert.ok(
    fs.existsSync(path.join(projectRoot, '.discipline', 'packets')),
    '.discipline/packets debe crearse en --once',
  )
})

test('discipline CLI: help (sin args) sale 0 y describe las dos capas', () => {
  const result = runTsx('tools/discipline/cli.ts', [])
  assert.equal(result.status, 0, getOutput(result))
  assert.match(getOutput(result), /Capa determinista/)
  assert.match(getOutput(result), /AUN NO IMPLEMENTADA/)
})

test('discipline CLI: comando desconocido falla claro (exit != 0)', () => {
  const result = runTsx('tools/discipline/cli.ts', ['frobnicate'])
  assert.notEqual(result.status, 0, getOutput(result))
  assert.match(getOutput(result), /desconocido/)
})

test('discipline CLI: --with-llm aun no implementado, falla con exit 2 y mensaje claro', () => {
  const result = runTsx('tools/discipline/cli.ts', ['step1', '--with-llm'])
  assert.equal(result.status, 2, getOutput(result))
  assert.match(getOutput(result), /not implemented/i)
})

test('discipline CLI: dispatch real corre un script existente y propaga exit 0', () => {
  // `status` es un dashboard read-only: sale 0 sin importar el PROFILE (a diferencia de
  // `doctor`, que sale 1 en PROFILE=LAUNCH/PROD sin scorecard). Prueba que el wrapper
  // realmente despacha a un npm script y propaga su exit, no solo que muestra help/error.
  const result = runTsx('tools/discipline/cli.ts', ['status'])
  assert.equal(result.status, 0, getOutput(result))
  assert.match(getOutput(result), /Discipline/i)
})

test('discipline CLI: --provider sin --with-llm falla claro (exit 1), no descarta el flag en silencio', () => {
  const result = runTsx('tools/discipline/cli.ts', ['step1', '--provider', 'claude'])
  assert.equal(result.status, 1, getOutput(result))
  assert.match(getOutput(result), /--provider solo aplica con --with-llm/)
})

// --- audit-merge (7.2): paso determinista del fan-out de verificacion ---

function writeRawAudit(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-audit-raw-'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8')
  }
  return dir
}

function envelope(overrides = {}) {
  return JSON.stringify({
    schema_version: 'discipline.agent_audit.v1',
    agent: 'discipline-rls-auditor',
    status: 'PASS',
    blocking: false,
    findings: [],
    summary: 'ok',
    ...overrides,
  })
}

test('audit-merge: fusiona envelopes validos y computa global PASS (exit 0)', () => {
  const dir = writeRawAudit({
    'a.json': envelope({ agent: 'discipline-rls-auditor', status: 'PASS' }),
    'b.json': envelope({ agent: 'discipline-a11y-checker', status: 'PASS' }),
  })
  const out = path.join(dir, 'report.json')
  const result = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', dir, '--out', out])
  assert.equal(result.status, 0, getOutput(result))
  assert.ok(fs.existsSync(out), 'debe escribir el reporte')
  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(report.global_status, 'PASS')
  assert.equal(report.blocking, false)
  assert.equal(report.agents.length, 2)
})

test('audit-merge: global FAIL si algun agente FAIL; advisory (exit 0) salvo --strict (exit 1)', () => {
  const failFinding = { severity: 'critical', rule: 'NN 17.3', location: 'm.sql:1', detail: 'x', fix: null }
  const dir = writeRawAudit({
    'a.json': envelope({ status: 'PASS' }),
    'b.json': envelope({ agent: 'discipline-security-reviewer', status: 'FAIL', findings: [failFinding], summary: '1 critical' }),
  })
  const out = path.join(path.dirname(dir), path.basename(dir) + '-report.json') // fuera del raw dir
  const advisory = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', dir, '--out', out])
  assert.equal(advisory.status, 0, getOutput(advisory)) // advisory: no bloquea
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).global_status, 'FAIL')
  const strict = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', dir, '--out', out, '--strict'])
  assert.equal(strict.status, 1, getOutput(strict)) // --strict: falla en CI
})

test('audit-merge: WARN si hay moderate pero ningun FAIL', () => {
  const mod = { severity: 'moderate', rule: 'scope-creep', location: 'x.ts', detail: 'd', fix: 'f' }
  const dir = writeRawAudit({
    'a.json': envelope({ status: 'PASS' }),
    'b.json': envelope({ agent: 'discipline-scope-guard', status: 'WARN', findings: [mod], summary: '1 moderate' }),
  })
  const out = path.join(dir, 'r.json')
  const result = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', dir, '--out', out])
  assert.equal(result.status, 0, getOutput(result))
  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(report.global_status, 'WARN')
  assert.equal(report.counts.moderate, 1)
})

test('audit-merge: envelope fuera de schema falla claro (exit 2), no fusiona', () => {
  const dir = writeRawAudit({
    'a.json': envelope({ status: 'PASS' }),
    'bad.json': envelope({ status: 'BROKEN' }), // status invalido
  })
  const result = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', dir, '--out', path.join(dir, 'r.json')])
  assert.equal(result.status, 2, getOutput(result))
  assert.match(getOutput(result), /contrato|agent_audit\.v1|invalido/i)
})

test('audit-merge: strippea fences ```json defensivamente', () => {
  const fenced = '```json\n' + envelope({ status: 'PASS' }) + '\n```'
  const dir = writeRawAudit({ 'a.json': fenced })
  const out = path.join(dir, 'r.json')
  const result = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', dir, '--out', out])
  assert.equal(result.status, 0, getOutput(result))
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).global_status, 'PASS')
})

test('audit-merge: acepta location y fix nulos', () => {
  const finding = { severity: 'critical', rule: 'legal-docs-present', location: null, detail: 'no privacy policy', fix: null }
  const dir = writeRawAudit({
    'a.json': envelope({ agent: 'discipline-legal-product-auditor', status: 'FAIL', findings: [finding], summary: '1 critical' }),
  })
  const out = path.join(dir, 'r.json')
  const result = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', dir, '--out', out])
  assert.equal(result.status, 0, getOutput(result))
  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(report.findings[0].location, null)
  assert.equal(report.findings[0].fix, null)
})

test('audit-merge: sin --raw-dir o carpeta vacia falla claro (exit 2)', () => {
  const noArg = runTsx('tools/discipline/audit-merge.ts', [])
  assert.equal(noArg.status, 2, getOutput(noArg))
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-audit-empty-'))
  const empty = runTsx('tools/discipline/audit-merge.ts', ['--raw-dir', emptyDir])
  assert.equal(empty.status, 2, getOutput(empty))
})

test('audit-merge: --expected completo → PASS, missing_agents vacio', () => {
  const dir = writeRawAudit({
    'a.json': envelope({ agent: 'discipline-scope-guard', status: 'PASS' }),
    'b.json': envelope({ agent: 'discipline-security-reviewer', status: 'PASS' }),
  })
  const out = path.join(path.dirname(dir), path.basename(dir) + '-rep.json')
  const result = runTsx('tools/discipline/audit-merge.ts', [
    '--raw-dir', dir, '--out', out,
    '--expected', 'discipline-scope-guard,discipline-security-reviewer',
  ])
  assert.equal(result.status, 0, getOutput(result))
  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(report.global_status, 'PASS')
  assert.deepEqual(report.missing_agents, [])
})

test('audit-merge: --expected faltante → WARN + missing_agents (advisory exit 0)', () => {
  const dir = writeRawAudit({
    'a.json': envelope({ agent: 'discipline-scope-guard', status: 'PASS' }),
  })
  const out = path.join(path.dirname(dir), path.basename(dir) + '-rep.json')
  const result = runTsx('tools/discipline/audit-merge.ts', [
    '--raw-dir', dir, '--out', out,
    '--expected', 'discipline-scope-guard,discipline-security-reviewer',
  ])
  assert.equal(result.status, 0, getOutput(result)) // advisory: no bloquea
  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(report.global_status, 'WARN', 'auditoria parcial no es PASS limpio')
  assert.deepEqual(report.missing_agents, ['discipline-security-reviewer'])
})

test('audit-merge: --expected faltante + --strict → exit no-cero', () => {
  const dir = writeRawAudit({
    'a.json': envelope({ agent: 'discipline-scope-guard', status: 'PASS' }),
  })
  const out = path.join(path.dirname(dir), path.basename(dir) + '-rep.json')
  const result = runTsx('tools/discipline/audit-merge.ts', [
    '--raw-dir', dir, '--out', out,
    '--expected', 'discipline-scope-guard,discipline-security-reviewer', '--strict',
  ])
  assert.notEqual(result.status, 0, getOutput(result))
})

// --- check-db-types (7.3-B): decision pura (read-only) + parser de provider ---

test('check-db-types: no-Supabase → skip exit 0', () => {
  const r = decideDbTypes({ provider: 'FIREBASE', strict: false, cliAvailable: false, committedExists: false })
  assert.equal(r.code, 0)
  assert.equal(r.level, 'skip')
})

test('check-db-types: provider unset → skip exit 0 (incluso en strict)', () => {
  const r = decideDbTypes({ provider: null, strict: true, cliAvailable: false, committedExists: false })
  assert.equal(r.code, 0)
  assert.equal(r.level, 'skip')
})

test('check-db-types: Supabase + sin CLI/DB, modo normal → warn exit 0', () => {
  const r = decideDbTypes({ provider: 'SUPABASE', strict: false, cliAvailable: false, committedExists: true })
  assert.equal(r.code, 0)
  assert.equal(r.level, 'warn')
})

test('check-db-types: Supabase + sin CLI/DB, modo strict → fail exit 1', () => {
  const r = decideDbTypes({ provider: 'SUPABASE', strict: true, cliAvailable: false, committedExists: true })
  assert.equal(r.code, 1)
  assert.equal(r.level, 'fail')
})

test('check-db-types: Supabase activo pero falta database.types.ts committeado → fail exit 1', () => {
  const r = decideDbTypes({ provider: 'SUPABASE', strict: false, cliAvailable: true, committedExists: false })
  assert.equal(r.code, 1)
  assert.equal(r.level, 'fail')
})

test('check-db-types: generated != committed → fail exit 1 (drift)', () => {
  const r = decideDbTypes({
    provider: 'SUPABASE', strict: false, cliAvailable: true, committedExists: true,
    committed: 'export type A = { id: number }\n',
    generated: 'export type A = { id: number; name: string }\n',
  })
  assert.equal(r.code, 1)
  assert.equal(r.level, 'fail')
})

test('check-db-types: generated == committed, tolerante a CRLF → ok exit 0', () => {
  const r = decideDbTypes({
    provider: 'SUPABASE', strict: false, cliAvailable: true, committedExists: true,
    committed: 'export type A = { id: number }\r\n', // checkout Windows (CRLF)
    generated: 'export type A = { id: number }\n', // supabase gen (LF)
  })
  assert.equal(r.code, 0)
  assert.equal(r.level, 'ok')
})

test('check-db-types: parseBackendProvider ignora vacio y VITE_BACKEND_PROVIDER', () => {
  assert.equal(parseBackendProvider('- BACKEND_PROVIDER:\n- LANE: WEB'), null)
  assert.equal(parseBackendProvider('- BACKEND_PROVIDER: SUPABASE'), 'SUPABASE')
  assert.equal(parseBackendProvider('- VITE_BACKEND_PROVIDER: Provider selection.'), null)
  assert.equal(parseBackendProvider('- backend_provider = supabase'), 'SUPABASE')
  assert.equal(parseBackendProvider('- BACKEND_PROVIDER: local-mock'), 'LOCAL-MOCK')
})
