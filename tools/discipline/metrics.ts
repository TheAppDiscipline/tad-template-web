import minimist from 'minimist';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { METRICS_FILE, recordSliceMetrics } from './lib/metrics.js';

const args = minimist(process.argv.slice(2));
const root = resolveProjectRoot(args['project-dir']);
const slice = args.slice === undefined ? '' : String(args.slice);
const base = args.base === undefined ? '' : String(args.base);

if (!slice || !base) {
  console.error('Usage: discipline metrics --slice <id> --base <ref>');
  process.exit(2);
}

try {
  const record = recordSliceMetrics(root, slice, base, typeof args['recorded-at'] === 'string' ? args['recorded-at'] : undefined);
  console.log(
    `Recorded slice ${record.slice}: ${record.actual.changed_lines} changed lines across ${record.actual.files} files `
    + `(maximum ${record.estimate.max_changed_lines}) -> ${METRICS_FILE.replace(/\\/g, '/')}`,
  );
} catch (err) {
  console.error(`discipline metrics: ${(err as Error).message}`);
  process.exit(1);
}
