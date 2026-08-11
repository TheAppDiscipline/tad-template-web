/**
 * Discipline Loop gate - Authenticated UI has an authenticated test that RUNS.
 *
 * The `authenticated-ui` surface exists because a screen behind a login fails in
 * ways a public one cannot: it renders somebody else's data, or it renders
 * nothing because the session was never established. `test:rls` and
 * `test:storage:privacy` prove the BACKEND isolates users; the public visual
 * gate proves the public screens render. Neither of them opens the app as a
 * signed-in user, so neither can catch either failure.
 *
 * This check fails closed on the three ways that verification goes missing:
 *
 *   1. `AUTH_MODE: NONE` in discipline.md. Then no slice can touch authenticated
 *      UI at all, and a packet that declared the surface contradicts the project.
 *   2. No file under `tests/e2e/authenticated/`.
 *   3. **Files that contain no test.** A file with the right extension is not a
 *      test: an empty one, one holding only a comment, or one that does not
 *      compile all look identical to `readdir`. So the RUNNER is asked how many
 *      tests it finds (`playwright test --list`), and zero is a failure. That is
 *      the runner's own answer, not this script guessing from the source.
 *
 * It still does not try to judge whether a test really signs in: reading intent
 * out of source is the kind of guess this pipeline refuses to make. What it
 * guarantees is that an authenticated suite exists, contains executable tests,
 * and is the suite `npm run e2e:auth` then runs.
 *
 * Exit 0 = the suite exists and the runner found tests in it.
 * Exit 1 = it does not, and the surface would have verified nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--project-dir');
const ROOT = dirFlag !== -1 && args[dirFlag + 1] ? path.resolve(args[dirFlag + 1]) : process.cwd();

/** Where this lane's authenticated tests live, how they are discovered, and what runs them. */
const SUITE = {
  dir: path.join('tests', 'e2e', 'authenticated'),
  extensions: ['.spec.ts', '.spec.js', '.test.ts'],
  // One string, not argv: `npx` is a .cmd on Windows and needs a shell, and passing args
  // alongside `shell: true` concatenates them unescaped (Node DEP0190).
  discover: (dir) => `npx playwright test --list "${dir}"`,
  // How the runner reports the count. If this stops matching (a Playwright version that words it
  // differently, another runner wired through --discover-command), the check FAILS: an exit code
  // with no count is not a count, and the file total is not an answer to "how many tests".
  countPattern: /Total:\s+(\d+)\s+test/i,
  runner: 'npm run e2e:auth',
};

/** POSIX form for messages: path.join gives backslashes on Windows and the docs use forward slashes. */
const SUITE_DIR = SUITE.dir.split(path.sep).join('/');

function fail(lines) {
  console.error(`[check-authenticated-ui] FAILED: ${lines[0]}`);
  for (const line of lines.slice(1)) console.error(`  ${line}`);
  process.exit(1);
}

function readAuthMode() {
  const disciplinePath = path.join(ROOT, 'discipline.md');
  if (!fs.existsSync(disciplinePath)) return null;
  const match = fs.readFileSync(disciplinePath, 'utf-8').match(/^-\s*AUTH_MODE:\s*(\S+)/m);
  return match ? match[1].replace(/#.*$/, '').trim().toUpperCase() : null;
}

function authenticatedFiles() {
  const dir = path.join(ROOT, SUITE.dir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SUITE.extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => entry.name);
}

const authMode = readAuthMode();
if (authMode === null) {
  fail([
    'discipline.md not found or it declares no AUTH_MODE.',
    'This check is what the `authenticated-ui` surface routes to, and it cannot run without the switch.',
  ]);
}

if (authMode === 'NONE') {
  fail([
    `discipline.md declares AUTH_MODE: ${authMode}.`,
    'Nothing in this project is behind a login, so no slice can touch authenticated UI.',
    'Either the packet declared `authenticated-ui` by mistake, or AUTH_MODE is out of date.',
  ]);
}

const files = authenticatedFiles();
if (files.length === 0) {
  fail([
    `no authenticated test under ${SUITE_DIR}/.`,
    `AUTH_MODE is ${authMode}, so this project has screens behind a login, and this slice touches them.`,
    'Write at least one test there that signs in and asserts what the signed-in screen shows.',
    `${SUITE.runner} runs that directory.`,
  ]);
}

// Ask the runner how many tests it can actually find. A file is not a test.
const commandFlag = args.indexOf('--discover-command');
const command = commandFlag !== -1 && args[commandFlag + 1] ? args[commandFlag + 1] : SUITE.discover(SUITE_DIR);
const listing = spawnSync(command, { cwd: ROOT, encoding: 'utf-8', shell: true });
const output = `${listing.stdout ?? ''}${listing.stderr ?? ''}`;
const quoted = output.trim().split(/\r?\n/).slice(0, 6).map((line) => `| ${line}`);

if (listing.error || listing.status !== 0) {
  fail([
    `the runner could not list any test in ${SUITE_DIR}/.`,
    `${files.length} file(s) are there, and none of them produced a runnable test.`,
    'An empty file, a file holding only comments, and a file that does not compile all look the same on disk.',
    ...quoted,
  ]);
}

// Exit 0 is not a count. A runner that succeeded and reported no number tells us nothing about
// how many tests are in there, and the number of FILES is the very thing this check exists to
// stop standing in for it. So an unreadable count fails, exactly like a count of zero.
const total = output.match(SUITE.countPattern);
if (!total) {
  fail([
    `the runner exited 0 but reported no test count for ${SUITE_DIR}/.`,
    `This check needs a number, and "${SUITE.countPattern}" matched nothing in its output.`,
    'The count of files is not the count of tests, so there is nothing here to accept.',
    ...quoted,
  ]);
}
if (Number(total[1]) === 0) {
  fail([
    `the runner found 0 tests in ${SUITE_DIR}/.`,
    `${files.length} file(s) are there, and none of them declares a test.`,
  ]);
}

console.log(`[check-authenticated-ui] OK: ${total[1]} test(s) in ${SUITE_DIR}/, run by ${SUITE.runner}.`);
process.exit(0);
