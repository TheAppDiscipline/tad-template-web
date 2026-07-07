import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import minimist from 'minimist';

export interface ClipboardCommand {
  file: string;
  args: string[];
}

/**
 * On win32, clip.exe decodes stdin with the console OEM codepage (CP850/CP437),
 * so UTF-8 accents (á, ñ, ¿) reach the clipboard corrupted. The content must
 * travel through a UTF-8 temp file that PowerShell reads back explicitly as
 * UTF-8 before calling Set-Clipboard; piping into powershell has the same
 * codepage problem as clip.exe.
 */
export function clipboardCommandFor(platform: NodeJS.Platform, tempFile: string): ClipboardCommand {
  if (platform === 'win32') {
    const escapedPath = tempFile.replace(/'/g, "''");
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-Command',
        `Set-Clipboard -Value (Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding UTF8)`,
      ],
    };
  }
  if (platform === 'darwin') return { file: 'pbcopy', args: [] };
  return { file: 'xclip', args: ['-selection', 'clipboard'] };
}

/** Throws when the platform clipboard tool fails; callers decide how to warn. */
export function copyToClipboard(content: string): void {
  if (process.platform === 'win32') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-clipboard-'));
    const tempFile = path.join(tempDir, 'clipboard.txt');
    try {
      fs.writeFileSync(tempFile, content, 'utf-8');
      const command = clipboardCommandFor('win32', tempFile);
      execFileSync(command.file, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return;
  }

  const command = clipboardCommandFor(process.platform, '');
  execFileSync(command.file, command.args, { input: content, stdio: ['pipe', 'ignore', 'pipe'] });
}

// Smoke-mode CLI used by the tooling tests and manual verification:
//   tsx tools/discipline/lib/clipboard.ts --print-command win32
//   tsx tools/discipline/lib/clipboard.ts --copy "árbol ñandú ¿qué?"
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2));
  if (typeof args['print-command'] === 'string') {
    console.log(JSON.stringify(clipboardCommandFor(args['print-command'] as NodeJS.Platform, 'CLIP_TEMP_FILE')));
  } else if (typeof args.copy === 'string') {
    copyToClipboard(args.copy);
    console.log('Copied to clipboard.');
  } else {
    console.error('Usage: clipboard.ts --print-command <platform> | --copy <text>');
    process.exit(1);
  }
}
