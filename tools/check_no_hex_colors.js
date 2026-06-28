import fs from 'node:fs';
import path from 'node:path';

/**
 * Visual Token Gate Script
 * Disallow hardcoded hex colors outside of token files.
 * Discipline Loop-friendly: deterministic + fast + avoids false positives.
 */

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');

const ALLOWED_FILES = new Set([
    path.normalize(path.join(SRC_DIR, 'styles', 'tokens.css')),
    path.normalize(path.join(SRC_DIR, 'styles', 'tokens.ts')),
]);

const ALLOWED_EXT = new Set(['.css', '.ts', '.tsx', '.js', '.jsx']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', 'coverage', '.vite']);

const HEX_REGEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (IGNORE_DIRS.has(entry.name)) continue;
            walk(fullPath);
            continue;
        }

        const ext = path.extname(entry.name);
        if (!ALLOWED_EXT.has(ext)) continue;

        const normalized = path.normalize(fullPath);
        if (ALLOWED_FILES.has(normalized)) continue;

        const content = fs.readFileSync(fullPath, 'utf8');
        const matches = content.match(HEX_REGEX);
        if (matches) {
            console.error('\x1b[31m[ERROR]\x1b[0m Hardcoded hex colors found in:', fullPath);
            console.error('    Found:', matches.join(', '));
            process.exit(1);
        }
    }
}

console.log('--- Visual Token Gate Check ---');

if (!fs.existsSync(SRC_DIR)) {
    console.log('\x1b[33m[SKIP]\x1b[0m No src/ directory found.');
    process.exit(0);
}

walk(SRC_DIR);
console.log('\x1b[32m[PASS]\x1b[0m No hardcoded hex colors found outside token files.');