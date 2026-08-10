import { type ParsedPatch, type PatchMode, VALID_PATCH_MODES } from './types.js';

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

  // Throw, never exit: this parser runs inside the watcher tick and inside applyPatches, and a
  // process.exit here kills the watcher on one malformed packet instead of rejecting that packet.
  if (!name) throw new Error(`Patch without a name (heading) in: ${filePath}`);
  if (!targetFile) throw new Error(`TARGET_FILE missing in patch: ${filePath}`);
  if (!patchMode) throw new Error(`PATCH_MODE missing in patch: ${filePath}`);
  if (!VALID_PATCH_MODES.includes(patchMode)) throw new Error(`Invalid PATCH_MODE "${patchMode}" in ${filePath}. Valid: ${VALID_PATCH_MODES.join(', ')}`);
  if (!anchor) throw new Error(`ANCHOR missing in patch: ${filePath}`);
  if (contentStartIdx === -1) throw new Error(`Marker "### CONTENT" not found in: ${filePath}`);

  const content = lines.slice(contentStartIdx).join('\n').trim();
  return { name, targetFile, patchMode, anchor, content, sourcePath: filePath };
}

/**
 * The patch blocks a packet carries. A bare `## NAME_PATCH_BLOCK` / `## NAME_APPEND_BLOCK` heading
 * is an OPERATIVE marker: it is the packet asking for a state file to be rewritten.
 *
 * A block the parser cannot read therefore THROWS. Skipping it made the packet behave as if it had
 * never carried that block: the operator saw a normal, successful tick and a state file that was
 * silently never patched, and the watcher's own rejection path was unreachable because the error
 * never left this function. The caller rejects the whole packet instead, naming the block.
 */
export function extractEmbeddedPatches(packetContent: string, packetPath: string): ParsedPatch[] {
  const lines = packetContent.split('\n');
  const patchPattern = /^#{1,3}\s+\w+_(PATCH_BLOCK|APPEND_BLOCK)$/;
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (patchPattern.test(lines[i].trim())) starts.push(i);
  }
  return starts.map((start, index) =>
    parsePatchFile(packetPath, lines.slice(start, starts[index + 1] ?? lines.length).join('\n')),
  );
}
