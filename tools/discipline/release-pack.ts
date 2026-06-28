import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import { resolveProjectRoot, readDisciplineConfig } from './lib/discipline-config.js';
import { validateScorecard, type ScorecardMode } from './validate-scorecard.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function readTail(relPath: string, maxLines = 30): string {
  const fullPath = path.join(projectRoot, relPath);
  if (!fs.existsSync(fullPath)) return '_No evidence found._';
  return fs.readFileSync(fullPath, 'utf8').split('\n').slice(-maxLines).join('\n').trim() || '_Empty file._';
}

function scorecardSummary(profile: string): string {
  if (profile !== 'LAUNCH' && profile !== 'PROD') {
    return `Profile ${profile || '(unset)'} does not require Gate D/E scorecard.`;
  }
  const mode: ScorecardMode = profile === 'PROD' ? 'prod' : 'launch';
  try {
    const report = validateScorecard(projectRoot, mode);
    return [
      `Mode: ${mode}`,
      `Target: ${report.target}`,
      `Errors: ${report.errors.length}`,
      `Warnings: ${report.warnings.length}`,
      ...report.sections.map(section => `- ${section.label}: ${section.result.passed}/${section.result.total}`),
    ].join('\n');
  } catch (err) {
    return `Scorecard could not be evaluated: ${(err as Error).message}`;
  }
}

function laneEvidence(lane: string): string {
  const normalized = lane.toUpperCase();
  if (normalized === 'WEB') {
    return [
      '- Deploy URL: Vercel/Netlify/custom URL reachable.',
      '- Command evidence: npm run gate:full.',
      '- Smoke evidence: login/core flow/empty/error states.',
      '- Legal routes: /privacy and /terms reachable when public.',
    ].join('\n');
  }
  if (normalized === 'MOBILE') {
    return [
      '- Build evidence: EAS build, TestFlight, or Internal Testing artifact.',
      '- Store metadata checklist attached.',
      '- Smoke evidence on a real or emulator device.',
      '- Privacy and account deletion notes when applicable.',
    ].join('\n');
  }
  if (normalized === 'DESKTOP') {
    return [
      '- Build evidence: Tauri unsigned/signed build artifact.',
      '- Smoke evidence for install/open/core flow.',
      '- Signing/notarization notes if distributed outside personal use.',
      '- Rollback path for the previous build.',
    ].join('\n');
  }
  if (normalized === 'EXTENSION') {
    return [
      '- Package evidence: npm run zip.',
      '- Manifest evidence: npm run check-manifest.',
      '- Local install smoke evidence.',
      '- Chrome Web Store / AMO submission checklist when public.',
    ].join('\n');
  }
  return '- Lane-specific evidence not detected. Add manual notes.';
}

let config;
try {
  config = readDisciplineConfig(projectRoot);
} catch {
  config = null;
}

const lane = (args.lane as string | undefined) ?? config?.lane ?? '(unset)';
const profile = config?.profile ?? '(unset)';
const date = (args.date as string | undefined) ?? todayIso();
const outDir = path.join(projectRoot, '.discipline', 'release-evidence');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${date}-release.md`);

const content = `# Release Evidence Pack - ${date}

## Project
- Project: ${config?.projectName ?? '(unknown)'}
- Lane: ${lane}
- Profile: ${profile}
- Deploy URL: ${(args['deploy-url'] as string | undefined) ?? '(pending)'}
- Gate status: ${(args.gate as string | undefined) ?? '(pending)'}

## Commands Run

\`\`\`
${readTail('.discipline/run-log.md')}
\`\`\`

## Scorecard Summary

\`\`\`
${scorecardSummary(profile)}
\`\`\`

## Expected Evidence By Lane

${laneEvidence(lane)}

## Known Issues Accepted

${(args['known-issues'] as string | undefined) ?? 'Review KNOWN-ISSUES.md and list accepted issues here.'}

## Rollback Evidence

- Previous stable version:
- Restore command or provider rollback:
- Data rollback notes:

## Legal And Safety Routes

- Privacy:
- Terms:
- Support/contact:
- Data deletion path:

## Human Approval

- Approved by:
- Date:
- Notes:
`;

fs.writeFileSync(outPath, content, 'utf8');
console.log(`Release evidence pack created: ${path.relative(projectRoot, outPath)}`);
