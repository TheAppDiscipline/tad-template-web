#!/usr/bin/env node
/**
 * Fake provider CLI for offline contract tests.
 *
 * Reads the whole prompt from stdin (proving stdin delivery), then emits output
 * shaped like a real provider CLI according to the FAKE_MODE env var:
 *
 *   ok       valid claude-style result JSON (includes session_id + cost), exit 0
 *   okjsonl  codex-style JSONL events (session id + usage + result line), exit 0
 *   failed   an error line on stderr, nonzero exit
 *   parked   a 429 rate-limit line (retry-later), exit nonzero
 *   hang     sleeps for FAKE_HANG_MS (default ~60s; a test may set it short so
 *            the timeout tree-kill assertion has margin without flakiness)
 *   build    like ok, but also WRITES real artifacts into cwd (a code file, a
 *            SLICE_COMPLETION_PACKET, and an embedded patch block) so an
 *            end-to-end `discipline run` can exercise plumbing + gate + checkpoint.
 *            Honors FAKE_BUILD_DIR (defaults to cwd) for where to write.
 *
 * It also echoes the received prompt length to stderr so a test can assert the
 * prompt actually arrived on stdin. It NEVER prints the prompt itself.
 *
 * This is a test fixture (a .mjs script, like the hooks), deliberately outside
 * the TypeScript sources: it is spawned as a real process by the runner tests.
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // If nothing is ever piped, resolve on a short timer so we do not hang.
    setTimeout(() => resolve(data), 3000).unref?.();
  });
}

async function main() {
  const mode = process.env.FAKE_MODE || 'ok';
  const prompt = await readStdin();
  // Prove stdin arrived without leaking prompt content.
  process.stderr.write(`fake-cli: received ${prompt.length} prompt chars (mode=${mode})\n`);

  switch (mode) {
    case 'ok': {
      const doc = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Fake builder completed the slice. Wrote code and tests.',
        session_id: 'fake-session-0001',
        total_cost_usd: 0.0123,
        usage: { input_tokens: 1200, output_tokens: 340 },
      };
      process.stdout.write(JSON.stringify(doc) + '\n');
      process.exit(0);
      break;
    }
    case 'okjsonl': {
      const lines = [
        { type: 'session', session_id: 'fake-codex-session-42' },
        { type: 'token_count', usage: { input_tokens: 800, output_tokens: 210 } },
        { type: 'item.completed', text: 'Fake codex builder finished. Emitted patch and packet.', total_cost_usd: 0.0088 },
        { type: 'result', text: 'done' },
      ];
      process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      process.exit(0);
      break;
    }
    case 'failed': {
      process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'compile error in module' }) + '\n');
      process.stderr.write('Error: fake CLI failed as requested (nonzero exit)\n');
      process.exit(3);
      break;
    }
    case 'parked': {
      // Rate-limit / retry-later. Must be classified as parked, never a repair failure.
      process.stderr.write('API error 429: rate limit exceeded, please retry later\n');
      process.exit(1);
      break;
    }
    case 'build': {
      // Write real artifacts so an end-to-end run has something to plumb, gate,
      // and checkpoint. Base dir: FAKE_BUILD_DIR or the current working dir.
      const base = process.env.FAKE_BUILD_DIR || process.cwd();
      const packetsDir = path.join(base, '.discipline', 'packets');
      fs.mkdirSync(packetsDir, { recursive: true });
      // 1) A code file so `git diff` is non-empty.
      fs.writeFileSync(path.join(base, 'feature.txt'), 'fake feature implemented by the builder\n', 'utf-8');
      // 2) A completion packet with an embedded FINDINGS_APPEND_BLOCK patch that
      //    targets findings.md at a canonical anchor (## Decisions).
      const completion = [
        '# SLICE_COMPLETION_PACKET',
        '',
        'STATUS: ready',
        'SOURCE_STEP: Step 5',
        '',
        '## Slice',
        '- Slice 1',
        '',
        '## Outcome',
        '- shipped',
        '',
        '## Scope delivered',
        '- fake feature file',
        '',
        '## Gates passed',
        '- yes',
        '',
        '## Deploy signal',
        '- local only',
        '',
        '## FINDINGS_APPEND_BLOCK',
        '',
        'TARGET_FILE: findings.md',
        'PATCH_MODE: append',
        'ANCHOR: ## Decisions',
        '',
        '### CONTENT',
        '- Slice 1 implemented by the fake builder (end-to-end smoke).',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(packetsDir, 'SLICE_COMPLETION_PACKET.md'), completion, 'utf-8');
      const doc = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Fake builder wrote feature.txt + SLICE_COMPLETION_PACKET.',
        session_id: 'fake-build-session',
        total_cost_usd: 0.02,
        usage: { input_tokens: 500, output_tokens: 120 },
      };
      process.stdout.write(JSON.stringify(doc) + '\n');
      process.exit(0);
      break;
    }
    case 'hang': {
      // Sleep long enough that any small timeoutMs fires first. The tree-kill
      // must terminate this promptly. Duration is configurable (FAKE_HANG_MS)
      // so a test can keep it short and still leave margin; default stays long.
      const hangMs = Number.parseInt(process.env.FAKE_HANG_MS ?? '', 10);
      setTimeout(() => process.exit(0), Number.isFinite(hangMs) && hangMs > 0 ? hangMs : 60000);
      break;
    }
    default: {
      process.stderr.write(`fake-cli: unknown FAKE_MODE "${mode}"\n`);
      process.exit(2);
    }
  }
}

main();
