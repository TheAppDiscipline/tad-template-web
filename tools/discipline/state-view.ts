import minimist from 'minimist';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { buildStateView, STATE_VIEW_FILE, writeStateView } from './lib/state-view.js';

const args = minimist(process.argv.slice(2));
const root = resolveProjectRoot(args['project-dir']);

try {
  const state = buildStateView(root);
  writeStateView(root, state);
  if (args.json === true) console.log(JSON.stringify(state, null, 2));
  else console.log(`Generated ${STATE_VIEW_FILE.replace(/\\/g, '/')}`);
} catch (err) {
  console.error(`discipline state-view: ${(err as Error).message}`);
  process.exit(1);
}
