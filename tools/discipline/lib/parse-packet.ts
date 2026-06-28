import type { ParsedPacket, PacketStatus } from './types.js';
import * as path from 'node:path';

export function parsePacketFile(filePath: string, fileContent: string): ParsedPacket {
  const lines = fileContent.split('\n');
  if (lines[0]?.trim() === '---') return parseFrontmatterFormat(filePath, lines);
  const headingMatch = lines[0]?.trim().match(/^#{1,3}\s+(.+)/);
  if (headingMatch) return parseHeadingFormat(filePath, lines, headingMatch[1]);
  return { name: deriveNameFromPath(filePath), status: 'draft', generatedBy: 'unknown', date: new Date().toISOString().slice(0, 10), body: fileContent, sourcePath: filePath };
}

function parseFrontmatterFormat(filePath: string, lines: string[]): ParsedPacket {
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { endIdx = i; break; } }
  const fm: Record<string, string> = {};
  if (endIdx > 1) {
    for (let i = 1; i < endIdx; i++) {
      const m = lines[i].match(/^(\w[\w_]*)\s*:\s*(.+)/);
      if (m) fm[m[1].toLowerCase()] = m[2].trim();
    }
  }
  const body = endIdx > 0 ? lines.slice(endIdx + 1).join('\n').trim() : lines.slice(1).join('\n').trim();
  return {
    name: fm['packet'] || fm['name'] || deriveNameFromPath(filePath),
    status: (fm['status'] as PacketStatus) || 'draft',
    generatedBy: fm['generated_by'] || fm['generatedby'] || 'unknown',
    date: fm['date'] || new Date().toISOString().slice(0, 10),
    slice: fm['slice'] ? parseInt(fm['slice'], 10) : undefined,
    body, sourcePath: filePath,
  };
}

function parseHeadingFormat(filePath: string, lines: string[], headingText: string): ParsedPacket {
  let status: PacketStatus = 'draft'; let generatedBy = 'unknown'; let bodyStartIdx = 1;
  for (let i = 1; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    if (line.startsWith('STATUS:')) { status = line.replace('STATUS:', '').trim() as PacketStatus; bodyStartIdx = i + 1; }
    else if (line.startsWith('SOURCE_STEP:')) { generatedBy = line.replace('SOURCE_STEP:', '').trim(); bodyStartIdx = i + 1; }
    else if ((line === '' || line.startsWith('#')) && bodyStartIdx <= 1) bodyStartIdx = i;
  }
  return { name: headingText, status, generatedBy, date: new Date().toISOString().slice(0, 10), body: lines.slice(bodyStartIdx).join('\n').trim(), sourcePath: filePath };
}

function deriveNameFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.draft\.md$/, '').replace(/\.superseded\.md$/, '').replace(/\.md$/, '');
}
