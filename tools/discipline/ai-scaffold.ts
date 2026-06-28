import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import { disciplineInfo, disciplineError } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';

const args = minimist(process.argv.slice(2));
const featureName = args._[0] || args.feature;
const projectRoot = resolveProjectRoot(args['project-dir']);

if (!featureName) {
  disciplineError('Usage: discipline:ai-scaffold <feature-name>');
  disciplineError('Example: npm run discipline:ai-scaffold -- summarize');
  process.exit(1);
}

const slug = featureName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

const promptDir = path.join(projectRoot, 'prompts', slug);
const evalFile = path.join(projectRoot, 'evals', `${slug}.jsonl`);
const templatePromptDir = path.join(projectRoot, 'prompts', '_templates');
const templateEvalFile = path.join(projectRoot, 'evals', '_templates', 'feature.template.jsonl');

// Check templates exist
if (!fs.existsSync(path.join(templatePromptDir, 'system.md'))) {
  disciplineError('Template prompts/_templates/system.md not found. Is this a The App Discipline template repo?');
  process.exit(1);
}

// Create prompt directory
if (fs.existsSync(promptDir)) {
  disciplineInfo(`prompts/${slug}/ already exists. Skipping directory creation.`);
} else {
  fs.mkdirSync(promptDir, { recursive: true });
  disciplineInfo(`Created: prompts/${slug}/`);
}

// Copy and interpolate system.md
const systemDest = path.join(promptDir, 'system.md');
if (!fs.existsSync(systemDest)) {
  const systemTemplate = fs.readFileSync(path.join(templatePromptDir, 'system.md'), 'utf-8');
  const systemContent = systemTemplate.replace(/<feature_name>/g, featureName);
  fs.writeFileSync(systemDest, systemContent, 'utf-8');
  disciplineInfo(`Created: prompts/${slug}/system.md`);
} else {
  disciplineInfo(`prompts/${slug}/system.md already exists. Skipping.`);
}

// Copy and interpolate schema.json
const schemaDest = path.join(promptDir, 'schema.json');
if (!fs.existsSync(schemaDest)) {
  const schemaTemplate = fs.readFileSync(path.join(templatePromptDir, 'schema.json'), 'utf-8');
  const schemaContent = schemaTemplate.replace(/<feature_name>/g, featureName);
  fs.writeFileSync(schemaDest, schemaContent, 'utf-8');
  disciplineInfo(`Created: prompts/${slug}/schema.json`);
} else {
  disciplineInfo(`prompts/${slug}/schema.json already exists. Skipping.`);
}

// Copy eval template
if (!fs.existsSync(evalFile)) {
  if (fs.existsSync(templateEvalFile)) {
    fs.copyFileSync(templateEvalFile, evalFile);
    disciplineInfo(`Created: evals/${slug}.jsonl`);
  } else {
    disciplineInfo('No eval template found. Create evals manually.');
  }
} else {
  disciplineInfo(`evals/${slug}.jsonl already exists. Skipping.`);
}

// Summary
console.log(`
AI feature scaffolded: ${featureName}

Files created:
  prompts/${slug}/system.md    - Edit the system prompt for this feature
  prompts/${slug}/schema.json  - Define the expected JSON output schema
  evals/${slug}.jsonl           - Add 10+ test cases (min for gate)

Next steps:
  1. Edit system.md with the real prompt for "${featureName}"
  2. Edit schema.json $defs.Data with the real output shape
  3. Add 10+ eval cases in ${slug}.jsonl
  4. Run: npm run ai:smoke
  5. Run: npm run ai:eval
`);
