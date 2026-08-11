import * as fs from 'node:fs';
import * as path from 'node:path';

export const DOCUMENT_WARNING_BYTES = 250 * 1024;
export const DOCUMENT_HIGH_WARNING_BYTES = 500 * 1024;
export const DOCUMENT_WARNING_LINES = 2000;

export const DISCIPLINE_DOCUMENTS = [
  'task_plan.md',
  'findings.md',
  'task_plan_archive.md',
  'findings_archive.md',
] as const;

export interface DocumentHealth {
  file: string;
  exists: boolean;
  bytes: number;
  lines: number;
  warning: 'normal' | 'high' | null;
}

export function inspectDocument(root: string, file: string): DocumentHealth {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return { file, exists: false, bytes: 0, lines: 0, warning: null };
  const bytes = fs.statSync(full).size;
  const content = fs.readFileSync(full, 'utf-8');
  const lines = content.length === 0
    ? 0
    : content.split(/\r?\n/).length - (/\r?\n$/.test(content) ? 1 : 0);
  const warning = bytes > DOCUMENT_HIGH_WARNING_BYTES
    ? 'high'
    : bytes > DOCUMENT_WARNING_BYTES || lines > DOCUMENT_WARNING_LINES
      ? 'normal'
      : null;
  return { file, exists: true, bytes, lines, warning };
}

export function inspectDisciplineDocuments(root: string): DocumentHealth[] {
  return DISCIPLINE_DOCUMENTS.map((file) => inspectDocument(root, file));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
