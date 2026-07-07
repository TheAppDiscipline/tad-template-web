import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv, { type ValidateFunction } from 'ajv';

/**
 * Optional packet frontmatter parsing and validation (warn-only).
 *
 * A packet MAY start with a YAML frontmatter block delimited by `---`. When
 * present, it is parsed with js-yaml and validated against
 * schemas/packet-meta.schema.json. Legacy packets without frontmatter are fine.
 *
 * The human-readable markdown body stays canonical: this metadata never changes
 * a gate or validation exit code. Callers surface `errors` as warnings only.
 */

export interface PacketMetaResult {
  /** Parsed frontmatter object when present and shaped like an object, else null. */
  meta: Record<string, unknown> | null;
  /** Human-readable validation / parse problems. Empty when there is nothing to report. */
  errors: string[];
}

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'packet-meta.schema.json');

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

/**
 * Parse a packet's optional YAML frontmatter.
 *
 * - No leading `---\n`: legacy packet -> { meta: null, errors: [] }.
 * - Frontmatter present but unterminated / not valid YAML / not an object, or
 *   valid YAML that fails the schema -> { meta, errors: [...] } (meta may be
 *   null when it could not be parsed into an object).
 */
export function parsePacketMeta(markdown: string): PacketMetaResult {
  const normalized = markdown.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { meta: null, errors: [] };
  }

  // Find the closing fence: a line that is exactly `---` after the opening one.
  const lines = normalized.split(/\r?\n/);
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return { meta: null, errors: ['Frontmatter opened with "---" but no closing "---" was found.'] };
  }

  const yamlText = lines.slice(1, closeIndex).join('\n');
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (err) {
    return { meta: null, errors: [`Frontmatter is not valid YAML: ${(err as Error).message}`] };
  }

  if (parsed === null || parsed === undefined) {
    return { meta: null, errors: ['Frontmatter is empty.'] };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { meta: null, errors: ['Frontmatter must be a YAML mapping (key: value).'] };
  }

  const meta = parsed as Record<string, unknown>;
  const validate = getValidator();
  const errors: string[] = [];
  if (!validate(meta)) {
    for (const e of validate.errors ?? []) {
      const where = e.instancePath || '/';
      errors.push(`${where} ${e.message}`.trim());
    }
  }
  return { meta, errors };
}
