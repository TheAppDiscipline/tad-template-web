import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import { disciplineInfo } from './lib/types.js';
import { generateProviderConfig } from './provider-config.js';

const args = minimist(process.argv.slice(2));
const projectDir = path.resolve(args['project-dir'] || process.cwd());
const VALID_LANES = ['WEB', 'MOBILE', 'DESKTOP', 'EXTENSION', 'BACKEND', 'WEB_SSR', 'CLI'];
const lane = (args.lane || 'WEB').toUpperCase();
if (!VALID_LANES.includes(lane)) {
  console.error(`[Discipline Loop] Invalid lane: "${lane}". Valid values: ${VALID_LANES.join(', ')}`);
  process.exit(1);
}
const profile = (args.profile || 'LITE').toUpperCase();
const backend = (args.backend || 'LOCAL_ONLY').toUpperCase();
const auth = (args.auth || 'NONE').toUpperCase();
const collab = (args.collab || 'VIEW_ONLY').toUpperCase();
const sync = (args.sync || 'FAST_UI').toUpperCase();
const ai = (args.ai || 'none').toLowerCase();
const push = args.push === 'true' ? 'true' : 'false';
const hosting = args.hosting || 'Vercel';
const force = args.force === true;

for (const dir of ['.discipline/packets', '.discipline/patches/pending', '.discipline/patches/applied', '.discipline/paste-ready', '.discipline/prompts', '.discipline/backups']) {
  const full = path.join(projectDir, dir);
  if (!fs.existsSync(full)) { fs.mkdirSync(full, { recursive: true }); disciplineInfo(`Created: ${dir}/`); }
}

function writeIfNew(relPath: string, content: string) {
  const full = path.join(projectDir, relPath);
  if (fs.existsSync(full) && !force) { disciplineInfo(`Already exists: ${relPath} (skipped, use --force to overwrite)`); return; }
  if (fs.existsSync(full) && force) disciplineInfo(`Overwriting: ${relPath}`);
  fs.writeFileSync(full, content, 'utf-8');
  if (!force) disciplineInfo(`Created: ${relPath}`);
}

writeIfNew('discipline.md', `# discipline.md — Project Constitution

## 0) Profile
- PROJECT_NAME: <APP_NAME>
- PRIMARY_GOAL: <one sentence>
- NORTH_STAR_METRIC: <measurable metric>
- PROFILE: ${profile}
- BACKEND_PROVIDER: ${backend}
- AUTH_MODE: ${auth}
- COLLAB_MODE: ${collab}
- STACK:
  - Frontend: ${lane === 'WEB' ? 'PWA (Web)' : lane}
  - Hosting: ${hosting}
  - Backend: ${backend}
- SYNC_MODE: ${sync}
- PUSH_PLUGIN: ${push}
- AI_FEATURES: ${ai}
- LANE: ${lane}
- STEP4_EXPANSION_MODE: batch
- READY_PROMOTION: per_packet
- DOCTRINE_VERSION: 1.0

## Env Configuration
- BACKEND_PROVIDER and AUTH_MODE above are materialized by \`npm run discipline:provider:generate\`.
- .env stores credentials only; it must not declare provider or auth mode.

## 1) Non-Negotiables
- Data-First contracts
- One Writer Per Slice
- Gates: lint + typecheck + tests

## 2) Tenancy & Permissions

## 3) Data Model

## 4) API / IO Shapes

## 5) Sync Rules

## 6) UI State Model
- loading, empty, error

## 7) Event / Notifications Model

## 8) Design Tokens Contract

## 9) Testing / Gates Contract

## 10) LLM Contracts
> Only if AI_FEATURES=enabled

## 11) Universal Definition of Done
`);
writeIfNew('task_plan.md', `# task_plan.md

## 1) Current Goal

## 2) Definition of Ready

## 3) Definition of Done

## 4) Ready Slices

## 5) Deferred / Later

## 6) Risks and Dependencies
`);
writeIfNew('findings.md', `# findings.md

## Decisions

## Open Questions

## Risks

## Constraints

## Assumptions

## Deferred
`);
writeIfNew('progress.md', `# progress.md — Current Status + Logs

## Current Status
- Working on: N/A
- Next: Fill discipline.md (Step 1)
- Blockers: none

## Last Completed Slices
1) (empty)
2) (empty)
3) (empty)

## Open Errors
- (none)

## Next Actions
- Choose BACKEND_PROVIDER, run discipline:provider:generate${lane === 'EXTENSION' ? '' : ', then run backend:smoke when credentials exist'}

## Deploy Notes
- N/A

---
`);
writeIfNew('.discipline/run-log.md', `# Run Log

| Date | Step | Tool | Input | Output | Notes |
|---|---|---|---|---|---|
`);
writeIfNew('.discipline/prompts/step-5-prompt.md', `Implement only the slice defined in STEP_5_SLICE_PACKET in the open repository.

Before editing:
1. Read the packet and every file it names.
2. Respect its Scope IN, Scope OUT, contracts, and allowed files.
3. If it includes visual or AI context, use it only for this slice.
4. If essential information is missing, stop and explain exactly what is missing.

When finished:
1. Run the gates named by the packet.
2. Do not finish with out-of-scope changes or a failing gate.
3. Return a SLICE_COMPLETION_PACKET with the changes and gate evidence.
`);

generateProviderConfig(projectDir);
disciplineInfo(`\nProject hydrated. Lane: ${lane} | Profile: ${profile} | Backend: ${backend}`);
