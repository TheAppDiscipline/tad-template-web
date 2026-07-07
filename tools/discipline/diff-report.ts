import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';

/**
 * Turn the current git diff into ONE self-contained HTML file under
 * `.discipline/review/<yyyymmdd-hhmmss>.html`: inline CSS, monospace, red/green
 * line backgrounds, one collapsible <details> per file. Everything is
 * HTML-escaped, so a diff that contains e.g. <script> is shown as text.
 *
 * Default source is `git diff`; `--staged` reviews the staged changes. `--open`
 * opens the file in the default browser. An empty diff prints a notice and
 * writes no file (still exit 0). No network, no external dependency.
 */

interface DiffFile {
  header: string;
  oldPath: string;
  newPath: string;
  added: number;
  removed: number;
  lines: string[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Split a unified diff into per-file blocks and count +/- lines. */
function splitDiffFiles(diffText: string): DiffFile[] {
  const lines = diffText.split(/\r?\n/);
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        header: line,
        oldPath: match ? match[1] : '',
        newPath: match ? match[2] : line.replace(/^diff --git /, ''),
        added: 0,
        removed: 0,
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }
  if (current) files.push(current);
  return files;
}

/** CSS class for a single diff line based on its leading marker. */
function lineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) return 'meta';
  return 'ctx';
}

export interface DiffToHtmlOptions {
  repoName?: string;
  timestamp?: string;
}

/** Pure transform: unified diff text -> one self-contained HTML document. */
export function diffToHtml(diffText: string, opts: DiffToHtmlOptions = {}): string {
  const repoName = opts.repoName ?? 'repository';
  const ts = opts.timestamp ?? new Date().toISOString();
  const files = splitDiffFiles(diffText);
  const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0);

  const fileSections = files
    .map((file) => {
      const body = [file.header, ...file.lines]
        .map((line) => `<span class="line ${lineClass(line)}">${escapeHtml(line) || '&nbsp;'}</span>`)
        .join('\n');
      const title = escapeHtml(file.newPath !== '/dev/null' ? file.newPath : file.oldPath);
      return (
        `<details open>\n` +
        `<summary>${title} <span class="stat"><span class="plus">+${file.added}</span> <span class="minus">-${file.removed}</span></span></summary>\n` +
        `<pre class="diff">${body}</pre>\n` +
        `</details>`
      );
    })
    .join('\n');

  const css = [
    'body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0;padding:1.5rem;background:#0d1117;color:#c9d1d9;}',
    'h1{font-size:1.1rem;margin:0 0 .25rem;}',
    '.head{margin-bottom:1rem;color:#8b949e;font-size:.85rem;}',
    '.head .plus{color:#3fb950;}.head .minus{color:#f85149;}',
    'details{border:1px solid #30363d;border-radius:6px;margin-bottom:1rem;overflow:hidden;}',
    'summary{cursor:pointer;padding:.5rem .75rem;background:#161b22;font-weight:600;}',
    'summary .stat{font-weight:400;margin-left:.5rem;}',
    '.plus{color:#3fb950;}.minus{color:#f85149;}',
    'pre.diff{margin:0;padding:0;overflow-x:auto;font-size:.8rem;line-height:1.4;}',
    '.line{display:block;padding:0 .75rem;white-space:pre;}',
    '.line.add{background:rgba(63,185,80,.15);}',
    '.line.del{background:rgba(248,81,73,.15);}',
    '.line.hunk{background:rgba(56,139,253,.15);color:#79c0ff;}',
    '.line.meta{color:#8b949e;}',
    '.line.ctx{color:#c9d1d9;}',
  ].join('');

  const summary = files.length === 0
    ? '<p>No changes.</p>'
    : `<div class="head">${escapeHtml(repoName)} &middot; ${escapeHtml(ts)} &middot; ${files.length} file(s) &middot; <span class="plus">+${totalAdded}</span> <span class="minus">-${totalRemoved}</span></div>`;

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>Discipline diff review - ${escapeHtml(repoName)}</title>\n` +
    `<style>${css}</style>\n</head>\n<body>\n` +
    `<h1>Diff review</h1>\n${summary}\n${fileSections}\n` +
    `</body>\n</html>\n`
  );
}

function timestampSlug(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function openInBrowser(filePath: string): void {
  const platform = process.platform;
  try {
    if (platform === 'win32') spawnSync('cmd', ['/c', 'start', '', filePath], { stdio: 'ignore' });
    else if (platform === 'darwin') spawnSync('open', [filePath], { stdio: 'ignore' });
    else spawnSync('xdg-open', [filePath], { stdio: 'ignore' });
  } catch {
    disciplineWarn(`Could not open ${filePath} in a browser.`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2));
  const projectRoot = resolveProjectRoot(args['project-dir']);
  const staged = args.staged === true;

  const gitArgs = ['diff'];
  if (staged) gitArgs.push('--staged');
  const proc = spawnSync('git', gitArgs, { cwd: projectRoot, encoding: 'utf-8' });
  if (proc.status !== 0) {
    disciplineWarn(`git ${gitArgs.join(' ')} failed: ${(proc.stderr || '').trim()}`);
    process.exit(proc.status ?? 1);
  }

  const diffText = proc.stdout ?? '';
  if (!diffText.trim()) {
    disciplineInfo(`No ${staged ? 'staged ' : ''}changes to review. No file written.`);
    process.exit(0);
  }

  const html = diffToHtml(diffText, { repoName: path.basename(projectRoot), timestamp: new Date().toISOString() });
  const reviewDir = path.join(projectRoot, '.discipline', 'review');
  fs.mkdirSync(reviewDir, { recursive: true });
  const outPath = path.join(reviewDir, `${timestampSlug()}.html`);
  fs.writeFileSync(outPath, html, 'utf-8');
  disciplineInfo(`Diff review written: ${path.relative(projectRoot, outPath)}`);

  if (args.open === true) openInBrowser(outPath);
  process.exit(0);
}
