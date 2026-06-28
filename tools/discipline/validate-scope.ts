import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import yaml from 'js-yaml';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { disciplineError, disciplineInfo } from './lib/types.js';

interface IdeaValidation {
  decision?: 'GO' | 'NO_GO' | 'PIVOT';
  target_user?: string;
  problem?: string;
  success_metric?: string;
  scope_in?: string[] | string;
  scope_out?: string[] | string;
  lane?: string;
  evidence?: string[] | string;
}

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const filePath = path.join(projectRoot, '.discipline', 'idea-validation.yaml');

if (!fs.existsSync(filePath)) {
  disciplineError('.discipline/idea-validation.yaml not found. Create it before Gate A or run the Step 1 prompt pack.');
}

const data = yaml.load(fs.readFileSync(filePath, 'utf8')) as IdeaValidation | null;
if (!data || typeof data !== 'object') {
  disciplineError('.discipline/idea-validation.yaml is empty or invalid.');
}

const errors: string[] = [];
const required: Array<keyof IdeaValidation> = [
  'decision',
  'target_user',
  'problem',
  'success_metric',
  'scope_in',
  'scope_out',
  'lane',
];

for (const key of required) {
  const value = data[key];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)) {
    errors.push(`Missing required field: ${key}`);
  }
}

if (data.decision && !['GO', 'NO_GO', 'PIVOT'].includes(data.decision)) {
  errors.push('decision must be GO, NO_GO, or PIVOT');
}

if (data.decision === 'NO_GO' || data.decision === 'PIVOT') {
  errors.push(`Gate A decision is ${data.decision}; do not build until the idea is narrowed or changed.`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[ERROR] ${error}`);
  process.exit(1);
}

disciplineInfo('Gate A scope validation passed.');
