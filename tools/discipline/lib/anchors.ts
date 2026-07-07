// Canonical anchors from note 37 - Repo Anchors

export const DISCIPLINE_MD_ANCHORS = [
  '## 0) Profile',
  '## 1) Non-Negotiables',
  '## 2) Tenancy & Permissions',
  '## 3) Data Model',
  '## 4) API / IO Shapes',
  '## 5) Sync Rules',
  '## 6) UI State Model',
  '## 7) Event / Notifications Model',
  '## 8) Design Tokens Contract',
  '## 9) Testing / Gates Contract',
  '## 10) LLM Contracts',
  '## 11) Universal Definition of Done',
] as const;

export const TASK_PLAN_ANCHORS = [
  '## 1) Current Goal',
  '## 2) Definition of Ready',
  '## 3) Definition of Done',
  '## 4) Ready Slices',
  '## 5) Deferred / Later',
  '## 6) Risks and Dependencies',
] as const;

export const FINDINGS_ANCHORS = [
  '## Decisions',
  '## Open Questions',
  '## Risks',
  '## Constraints',
  '## Assumptions',
  '## Deferred',
] as const;

export const PROGRESS_ANCHORS = [
  '## Current Status',
  '## Last Completed Slices',
  '## Open Errors',
  '## Next Actions',
  '## Deploy Notes',
] as const;

export const PATCH_APPLICATION_ORDER = [
  'discipline.md',
  'task_plan.md',
  'findings.md',
] as const;

// Whitelist of files that patches can target
export const ALLOWED_PATCH_TARGETS = new Set(['discipline.md', 'task_plan.md', 'findings.md', 'progress.md']);

/**
 * Normalize line endings to LF. Critical on Windows where files have CRLF.
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function headingLevel(line: string): number {
  const match = line.match(/^(#{1,6})\s/);
  return match ? match[1].length : 0;
}

/**
 * Anchor comparison normalizes Unicode to NFC. A heading edited on macOS can
 * arrive in NFD ("ó" stored as "o" + U+0301) and would never match its NFC
 * twin byte by byte, so the patch would fail even though both strings render
 * identically.
 */
function anchorsEqual(line: string, anchor: string): boolean {
  return line.trim().normalize('NFC') === anchor.trim().normalize('NFC');
}

export function findSectionBounds(
  lines: string[],
  anchor: string
): { start: number; end: number } | null {
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (anchorsEqual(lines[i], anchor)) {
      if (startIdx !== -1) {
        return null; // duplicate anchor
      }
      startIdx = i;
    }
  }

  if (startIdx === -1) return null;

  const level = headingLevel(lines[startIdx]);
  let endIdx = lines.length;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const lvl = headingLevel(lines[i]);
    if (lvl > 0 && lvl <= level) {
      endIdx = i;
      break;
    }
  }

  return { start: startIdx, end: endIdx };
}

export function isDuplicateAnchor(lines: string[], anchor: string): boolean {
  let count = 0;
  for (const line of lines) {
    if (anchorsEqual(line, anchor)) count++;
    if (count > 1) return true;
  }
  return false;
}
