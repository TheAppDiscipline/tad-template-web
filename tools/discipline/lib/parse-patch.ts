import { type ParsedPatch, type PatchMode, VALID_PATCH_MODES, disciplineError } from './types.js';

export function parsePatchFile(filePath: string, fileContent: string): ParsedPatch {
  const lines = fileContent.split('\n');
  let name = '';
  let targetFile = '';
  let patchMode: PatchMode | '' = '';
  let anchor = '';
  let contentStartIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!name && (line.startsWith('## ') || line.startsWith('# '))) {
      name = line.replace(/^#{1,3}\s+/, '');
      continue;
    }
    if (line.startsWith('TARGET_FILE:')) targetFile = line.replace('TARGET_FILE:', '').trim();
    else if (line.startsWith('PATCH_MODE:')) patchMode = line.replace('PATCH_MODE:', '').trim() as PatchMode;
    else if (line.startsWith('ANCHOR:')) anchor = line.replace('ANCHOR:', '').trim();
    if (line === '### CONTENT' || line === '## CONTENT') { contentStartIdx = i + 1; break; }
  }

  if (!name) disciplineError(`Patch sin nombre (heading) en: ${filePath}`);
  if (!targetFile) disciplineError(`TARGET_FILE faltante en patch: ${filePath}`);
  if (!patchMode) disciplineError(`PATCH_MODE faltante en patch: ${filePath}`);
  if (!VALID_PATCH_MODES.includes(patchMode)) disciplineError(`PATCH_MODE inválido "${patchMode}" en ${filePath}. Válidos: ${VALID_PATCH_MODES.join(', ')}`);
  if (!anchor) disciplineError(`ANCHOR faltante en patch: ${filePath}`);
  if (contentStartIdx === -1) disciplineError(`Marcador "### CONTENT" no encontrado en: ${filePath}`);

  const content = lines.slice(contentStartIdx).join('\n').trim();
  return { name, targetFile, patchMode, anchor, content, sourcePath: filePath };
}

export function extractEmbeddedPatches(packetContent: string, packetPath: string): ParsedPatch[] {
  const lines = packetContent.split('\n');
  const patches: ParsedPatch[] = [];
  const patchPattern = /^#{1,3}\s+\w+_(PATCH_BLOCK|APPEND_BLOCK)$/;
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (patchPattern.test(lines[i].trim())) {
      if (blockStart !== -1) {
        try { patches.push(parsePatchFile(packetPath, lines.slice(blockStart, i).join('\n'))); } catch { /* skip malformed embedded patch */ }
      }
      blockStart = i;
    }
  }
  if (blockStart !== -1) {
    try { patches.push(parsePatchFile(packetPath, lines.slice(blockStart).join('\n'))); } catch { /* skip malformed embedded patch */ }
  }
  return patches;
}
