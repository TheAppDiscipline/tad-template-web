import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import yaml from 'js-yaml';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { disciplineError, disciplineInfo } from './lib/types.js';

interface ArchitectureLock {
  status?: 'draft' | 'locked';
  lane?: string;
  profile?: string;
  backend?: string;
  data_model?: string | object;
  risk_review?: string | object;
  auth_review?: string | object;
  security_review?: string | object;
  rls_review?: string | object;
  gate_b_decision?: 'PASS' | 'FAIL';
}

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const filePath = path.join(projectRoot, '.discipline', 'architecture-lock.yaml');

if (!fs.existsSync(filePath)) {
  disciplineError('.discipline/architecture-lock.yaml not found. Create it from Paso 2 before Gate B.');
}

const data = yaml.load(fs.readFileSync(filePath, 'utf8')) as ArchitectureLock | null;
if (!data || typeof data !== 'object') {
  disciplineError('.discipline/architecture-lock.yaml is empty or invalid.');
}

const errors: string[] = [];
const required: Array<keyof ArchitectureLock> = [
  'status',
  'lane',
  'profile',
  'data_model',
  'risk_review',
  'gate_b_decision',
];

function missing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

for (const key of required) {
  if (missing(data[key])) errors.push(`Missing required field: ${key}`);
}

if (data.status !== 'locked') errors.push('status must be locked before Gate B passes.');
if (data.gate_b_decision !== 'PASS') errors.push('gate_b_decision must be PASS.');

if (['SHARED_SYNC', 'LAUNCH', 'PROD'].includes((data.profile ?? '').toUpperCase())) {
  if (missing(data.auth_review)) errors.push('auth_review is required for SHARED_SYNC, LAUNCH, or PROD.');
  if (missing(data.security_review)) errors.push('security_review is required for SHARED_SYNC, LAUNCH, or PROD.');
}

if ((data.backend ?? '').toUpperCase() === 'SUPABASE' && missing(data.rls_review)) {
  errors.push('rls_review is required when backend=SUPABASE.');
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[ERROR] ${error}`);
  process.exit(1);
}

disciplineInfo('Gate B architecture validation passed.');
