import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import { disciplineInfo } from './lib/types.js';

const args = minimist(process.argv.slice(2));
const projectDir = path.resolve(args['project-dir'] || process.cwd());
const VALID_LANES = ['WEB', 'MOBILE', 'DESKTOP', 'EXTENSION', 'BACKEND', 'WEB_SSR', 'CLI'];
const lane = (args.lane || 'WEB').toUpperCase();
if (!VALID_LANES.includes(lane)) {
  console.error(`[Discipline Loop] Invalid lane: "${lane}". Valid values: ${VALID_LANES.join(', ')}`);
  process.exit(1);
}
const profile = (args.profile || 'SHARED_SYNC').toUpperCase();
const backend = (args.backend || 'SUPABASE').toUpperCase();
const auth = (args.auth || 'MAGIC_LINK').toUpperCase();
const collab = (args.collab || 'VIEW_ONLY').toUpperCase();
const sync = (args.sync || 'FAST_UI').toUpperCase();
const ai = (args.ai || 'none').toLowerCase();
const push = args.push === 'true' ? 'true' : 'false';
const hosting = args.hosting || 'Vercel';
const force = args.force === true;

const dirs = ['.discipline/packets', '.discipline/patches/pending', '.discipline/patches/applied', '.discipline/paste-ready', '.discipline/prompts', '.discipline/backups'];
for (const dir of dirs) {
  const full = path.join(projectDir, dir);
  if (!fs.existsSync(full)) { fs.mkdirSync(full, { recursive: true }); disciplineInfo(`Created: ${dir}/`); }
}

function writeIfNew(relPath: string, content: string) {
  const full = path.join(projectDir, relPath);
  if (fs.existsSync(full) && !force) { disciplineInfo(`Already exists: ${relPath} (skipped, use --force to overwrite)`); return; }
  if (fs.existsSync(full) && force) { disciplineInfo(`Overwriting: ${relPath}`); }
  fs.writeFileSync(full, content, 'utf-8');
  if (!force) disciplineInfo(`Created: ${relPath}`);
}

writeIfNew('discipline.md', `# discipline.md \u2014 Project Constitution\n\n## 0) Profile\n- PROJECT_NAME: <APP_NAME>\n- PRIMARY_GOAL: <one sentence>\n- NORTH_STAR_METRIC: <measurable metric>\n\n- PROFILE: ${profile}\n- BACKEND_PROVIDER: ${backend}\n- AUTH_MODE: ${auth}\n- COLLAB_MODE: ${collab}\n- STACK:\n  - Frontend: ${lane === 'WEB' ? 'PWA (Web)' : lane}\n  - Hosting: ${hosting}\n  - Backend: ${backend}\n- SYNC_MODE: ${sync}\n- PUSH_PLUGIN: ${push}\n- AI_FEATURES: ${ai}\n- LANE: ${lane}\n\n## Env Configuration\n- VITE_BACKEND_PROVIDER: Provider selection.\n- VITE_AUTH_MODE: Authentication strategy.\n\n### Supabase Env\n- VITE_SUPABASE_URL\n- VITE_SUPABASE_ANON_KEY\n\n### Firebase Env\n- VITE_FIREBASE_API_KEY\n- VITE_FIREBASE_AUTH_DOMAIN\n- VITE_FIREBASE_PROJECT_ID\n- VITE_FIREBASE_APP_ID\n\n## 1) Non-Negotiables\n- Data-First contracts\n- One Writer Per Slice\n- Gates: lint + typecheck + tests\n\n## 2) Tenancy & Permissions\n\n## 3) Data Model\n\n## 4) API / IO Shapes\n\n## 5) Sync Rules\n\n## 6) UI State Model\n- loading, empty, error\n\n## 7) Event / Notifications Model\n\n## 8) Design Tokens Contract\n\n## 9) Testing / Gates Contract\n\n## 10) LLM Contracts\n> Only if AI_FEATURES=enabled\n\n## 11) Universal Definition of Done\n`);

writeIfNew('task_plan.md', `# task_plan.md\n\n## 1) Current Goal\n\n## 2) Definition of Ready\n\n## 3) Definition of Done\n\n## 4) Ready Slices\n\n## 5) Deferred / Later\n\n## 6) Risks and Dependencies\n`);

writeIfNew('findings.md', `# findings.md\n\n## Decisions\n\n## Open Questions\n\n## Risks\n\n## Constraints\n\n## Assumptions\n\n## Deferred\n`);

writeIfNew('progress.md', `# progress.md \u2014 Current Status + Logs\n\n## Current Status\n- Working on: N/A\n- Next: Fill discipline.md (Paso 1)\n- Blockers: none\n\n## Last Completed Slices\n1) (empty)\n2) (empty)\n3) (empty)\n\n## Open Errors\n- (none)\n\n## Next Actions\n- Choose BACKEND_PROVIDER and run backend:smoke\n\n## Deploy Notes\n- N/A\n\n---\n`);

writeIfNew('.discipline/run-log.md', `# Run Log\n\n| Date | Step | Tool | Input | Output | Notes |\n|---|---|---|---|---|---|\n`);

disciplineInfo(`\nProject hydrated. Lane: ${lane} | Profile: ${profile} | Backend: ${backend}`);
