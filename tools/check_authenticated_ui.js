/**
 * Discipline Loop gate - Authenticated UI has an authenticated test.
 *
 * The `authenticated-ui` surface exists because a screen behind a login fails in
 * ways a public one cannot: it renders somebody else's data, or it renders
 * nothing because the session was never established. `test:rls` and
 * `test:storage:privacy` prove the BACKEND isolates users; the public visual
 * gate proves the public screens render. Neither of them opens the app as a
 * signed-in user, so neither can catch either failure.
 *
 * This check fails closed on the two ways that verification can be absent:
 *
 *   1. `AUTH_MODE: NONE` in discipline.md. Then no slice can touch authenticated
 *      UI at all, and a packet that declared the surface contradicts the project.
 *   2. No test under `tests/e2e/authenticated/`. That directory is inside
 *      Playwright's `testDir`, so `npm run gate:visual` runs whatever is in it.
 *      An empty one means the surface routes to nothing.
 *
 * It deliberately does NOT try to judge whether a test really signs in: reading
 * intent out of source is the kind of guess this pipeline refuses to make. It
 * checks that the test exists where the runner will execute it, and the runner
 * does the rest.
 *
 * Exit 0 = an authenticated suite exists and the visual gate will run it.
 * Exit 1 = it does not, and the surface would have verified nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** Where this lane's authenticated tests live, and what runs them. */
const SUITE = {
  dir: path.join('tests', 'e2e', 'authenticated'),
  extensions: ['.spec.ts', '.spec.js', '.test.ts'],
  runner: 'npm run gate:visual',
};

/** POSIX form for messages: path.join gives backslashes on Windows and the docs use forward slashes. */
const SUITE_DIR = SUITE.dir.split(path.sep).join('/');

function readAuthMode() {
  const disciplinePath = path.join(ROOT, 'discipline.md');
  if (!fs.existsSync(disciplinePath)) return null;
  const match = fs.readFileSync(disciplinePath, 'utf-8').match(/^-\s*AUTH_MODE:\s*(\S+)/m);
  return match ? match[1].replace(/#.*$/, '').trim().toUpperCase() : null;
}

function authenticatedTests() {
  const dir = path.join(ROOT, SUITE.dir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SUITE.extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => entry.name);
}

const authMode = readAuthMode();
if (authMode === null) {
  console.error('[check-authenticated-ui] FAILED: discipline.md not found or it declares no AUTH_MODE.');
  console.error('  This check is what the `authenticated-ui` surface routes to, and it cannot run without the switch.');
  process.exit(1);
}

if (authMode === 'NONE') {
  console.error(`[check-authenticated-ui] FAILED: discipline.md declares AUTH_MODE: ${authMode}.`);
  console.error('  Nothing in this project is behind a login, so no slice can touch authenticated UI.');
  console.error('  Either the packet declared `authenticated-ui` by mistake, or AUTH_MODE is out of date.');
  process.exit(1);
}

const tests = authenticatedTests();
if (tests.length === 0) {
  console.error(`[check-authenticated-ui] FAILED: no authenticated test under ${SUITE_DIR}/.`);
  console.error(`  AUTH_MODE is ${authMode}, so this project has screens behind a login, and this slice touches them.`);
  console.error(`  Write at least one test there that signs in and asserts what the signed-in screen shows.`);
  console.error(`  ${SUITE.runner} executes that directory, so the test runs with the rest of the visual gate.`);
  process.exit(1);
}

console.log(`[check-authenticated-ui] OK: ${tests.length} authenticated test(s) in ${SUITE_DIR}/ (run by ${SUITE.runner}).`);
console.log(`  ${tests.join(', ')}`);
process.exit(0);
