#!/usr/bin/env node
/**
 * Session-start anti-amnesia header (Claude Code SessionStart hook).
 *
 * Injects the FIXED HEADER of progress.md into the new session as additional
 * context, so the agent starts every session already knowing Current Status,
 * Last Completed Slices, Open Errors, Next Actions, and Deploy Notes without a
 * human pasting it. This turns the "paste the header at session start" protocol
 * from an instruction into a mechanism (files-first memory).
 *
 * The FIXED HEADER is defined as: the top of progress.md through the END of the
 * `## Deploy Notes` section, i.e. up to (but not including) the first `## `
 * heading that appears AFTER `## Deploy Notes`, or 60 lines from the top,
 * whichever comes first. That bounds the injected context regardless of how long
 * the log below the header grows.
 *
 * Protocol (Claude Code SessionStart):
 *   - stdout: {"hookSpecificOutput":{"hookEventName":"SessionStart",
 *     "additionalContext":"..."}}. The text is prefixed with a one-line preamble.
 *
 * Failure policy (documented): fails OPEN. If progress.md is missing, or reading
 * it throws, or the payload is unparseable, exit 0 silently and inject nothing.
 * A session must always start; missing memory is a soft degradation, not a stop.
 *
 * Pure extraction is exported (extractFixedHeader) so tests never need stdin.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_LINES = 60;
const DEPLOY_NOTES_HEADING = '## Deploy Notes';

/**
 * Extract the FIXED HEADER from progress.md text. Pure and import-able.
 *
 * Rules:
 *   - Start at line 0.
 *   - Find `## Deploy Notes`. From the line AFTER it, stop at the first `## `
 *     heading (the next top-level section), which ends the Deploy Notes block.
 *   - If `## Deploy Notes` is absent, fall back to the first `## ` heading only
 *     after we have some content, else the whole capped text.
 *   - Never return more than MAX_LINES lines.
 * Returns the header text (trimmed of trailing whitespace), or '' if empty.
 */
export function extractFixedHeader(text, maxLines = MAX_LINES) {
  const lines = String(text ?? '').split(/\r?\n/);
  const deployIdx = lines.findIndex((l) => l.trim() === DEPLOY_NOTES_HEADING);

  let endExclusive;
  if (deployIdx !== -1) {
    // End at the first `## ` heading after Deploy Notes; if none, end of file.
    endExclusive = lines.length;
    for (let i = deployIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        endExclusive = i;
        break;
      }
    }
  } else {
    // No Deploy Notes section: keep the whole file (still capped below).
    endExclusive = lines.length;
  }

  endExclusive = Math.min(endExclusive, maxLines);
  return lines.slice(0, endExclusive).join('\n').replace(/\s+$/, '');
}

// --- Hook I/O ---------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  // Drain stdin (the payload is not required for our output, but the hook
  // contract feeds it). We never throw on weird input.
  try {
    await readStdin();
  } catch {
    process.exit(0);
    return;
  }

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const progressPath = path.join(root, 'progress.md');

  let header = '';
  try {
    if (!fs.existsSync(progressPath)) {
      process.exit(0); // progress.md missing -> inject nothing, silently.
      return;
    }
    header = extractFixedHeader(fs.readFileSync(progressPath, 'utf-8'));
  } catch {
    process.exit(0); // read/parse error -> fail open.
    return;
  }

  if (!header.trim()) {
    process.exit(0);
    return;
  }

  const additionalContext = `Discipline Loop anti-amnesia header (progress.md):\n${header}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
