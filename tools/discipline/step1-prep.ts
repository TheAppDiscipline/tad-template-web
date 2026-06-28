#!/usr/bin/env npx tsx
/**
 * discipline:step1-prep — Generates Step 1 input files and prompt reference.
 *
 * Reads IDEA_VALIDATION_PACKET (if exists) + discipline.md switches.
 * Produces:
 *   .discipline/step1-input/00_Input_Bruto.md
 *   .discipline/step1-input/01_Ejemplos_Reales.md
 *   .discipline/step1-input/02_Restricciones.md
 *   .discipline/prompts/paso-1-all-prompts.md  (all 13 prompts, interpolated)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveProjectRoot, readDisciplineConfig } from './lib/discipline-config.js';
import { disciplineInfo } from './lib/types.js';
import { systemPrompt, getPrompt, OUTPUT_META } from './lib/step1-prompts.js';

const root = resolveProjectRoot();
const config = readDisciplineConfig(root);

// ─── Directories ────────────────────────────────────────
const inputDir = path.join(root, '.discipline', 'step1-input');
const promptsDir = path.join(root, '.discipline', 'prompts');
fs.mkdirSync(inputDir, { recursive: true });
fs.mkdirSync(promptsDir, { recursive: true });

// ─── Read IDEA_VALIDATION_PACKET if it exists ───────────
const packetPath = path.join(root, '.discipline', 'packets', 'IDEA_VALIDATION_PACKET.md');
const hasPacket = fs.existsSync(packetPath);
const packetContent = hasPacket ? fs.readFileSync(packetPath, 'utf-8') : '';

// ─── Generate 00_Input_Bruto ────────────────────────────
const inputBruto = hasPacket
  ? `# Input Bruto — ${config.projectName}

## IDEA_VALIDATION_PACKET (del Paso 0a)

${packetContent}

---

## Contexto adicional

Agrega aquí cualquier detalle extra que no esté en el packet:

- ¿Qué pantallas imaginas?
- ¿Qué datos guardará?
- ¿Qué odias de alternativas actuales?
- Screenshots o URLs de apps de referencia (si tienes)
`
  : `# Input Bruto — ${config.projectName}

Pega aquí todo lo que tengas sobre la idea, sin ordenar demasiado:

- ¿Qué problema resuelve?
- ¿Para quién es?
- ¿Por qué te importa?
- ¿Qué pantallas imaginas?
- ¿Qué datos guardará?
- ¿Requiere sync? ¿Notificaciones? ¿IA?
- ¿La usarás tú, un grupo de confianza o público?
- ¿Qué sería "éxito"?
- ¿Qué odias de alternativas actuales?
- Screenshots o URLs de apps de referencia (si tienes)
`;

// ─── Generate 01_Ejemplos_Reales ────────────────────────
const ejemplos = `# Ejemplos Reales — ${config.projectName}

Agrega 5–15 ejemplos concretos de uso:

Caso 1:
- Quiero poder...
- Resultado ideal...

Caso 2:
- Mi grupo compartido debería poder...
- Resultado ideal...

Caso 3:
- En iPhone quiero...
- En PC quiero...
`;

// ─── Generate 02_Restricciones ──────────────────────────
const restricciones = `# Restricciones — ${config.projectName}

## Switches ya elegidos
- LANE: ${config.lane}
- PROFILE: ${config.profile}
- BACKEND_PROVIDER: ${config.backendProvider}
- AUTH_MODE: ${config.authMode}
- COLLAB_MODE: ${config.collabMode}
- SYNC_MODE: ${config.syncMode}
- AI_FEATURES: ${config.aiFeatures}
- PUSH_PLUGIN: ${config.pushPlugin}
- HOSTING: ${config.hosting || '(por decidir)'}

## Restricciones adicionales

Completa según tu caso:

- Costo máximo mensual:
- Rapidez esperada:
- Menor debugging posible: sí
- Multi-dispositivo: ${config.profile === 'SHARED_SYNC' ? 'sí' : 'no'}
- Compartida: ${config.profile === 'SHARED_SYNC' ? 'sí' : 'no'}
- Offline importante: ${config.syncMode === 'OFFLINE_FIRST' ? 'sí' : 'no'}
- Privacidad: alta / media / baja
- Vender después: sí / no
`;

// ─── Write input files ──────────────────────────────────
fs.writeFileSync(path.join(inputDir, '00_Input_Bruto.md'), inputBruto);
fs.writeFileSync(path.join(inputDir, '01_Ejemplos_Reales.md'), ejemplos);
fs.writeFileSync(path.join(inputDir, '02_Restricciones.md'), restricciones);
disciplineInfo(`Input files generados en ${inputDir}`);

// ─── Generate all-prompts reference file ────────────────
let allPrompts = `# Paso 1 — Prompts
# Proyecto: ${config.projectName}
# Generado por: discipline:step1-prep
# Fecha: ${new Date().toISOString().split('T')[0]}

---

## SYSTEM PROMPT (pegar en ⚙️ Configura el chat → Personalizado → "Más larga")

\`\`\`
${systemPrompt(config)}
\`\`\`

---

`;

for (const meta of OUTPUT_META) {
  const skip = !meta.condition(config);
  const skipNote = skip ? ' **(SKIP — condición no aplica)**' : '';
  const prompt = getPrompt(meta.number, config);

  allPrompts += `## Output ${meta.number} — ${meta.noteTitle}${skipNote}

**Guardar como:** ${meta.packetFile ? `\`.discipline/packets/${meta.packetFile}\`` : `output intermedio \`${meta.noteTitle}\` (no genera packet)`}
${skip ? '\n> Este output se salta porque la condición no se cumple para este proyecto.\n' : ''}
\`\`\`
${prompt}
\`\`\`

---

`;
}

fs.writeFileSync(path.join(promptsDir, 'paso-1-all-prompts.md'), allPrompts);
disciplineInfo(`Archivo de prompts generado en ${path.join(promptsDir, 'paso-1-all-prompts.md')}`);

// ─── Summary ────────────────────────────────────────────
const activeOutputs = OUTPUT_META.filter(m => m.condition(config)).length;
console.log(`
╔══════════════════════════════════════════════════════════╗
║  discipline:step1-prep completado                            ║
╠══════════════════════════════════════════════════════════╣
║  Proyecto: ${config.projectName.padEnd(43)}║
║  LANE: ${config.lane.padEnd(48)}║
║  Outputs activos: ${String(activeOutputs).padEnd(36)}║
║  IDEA_VALIDATION_PACKET: ${(hasPacket ? 'sí' : 'no').padEnd(30)}║
╠══════════════════════════════════════════════════════════╣
║  Archivos generados:                                    ║
║  .discipline/step1-input/00_Input_Bruto.md                   ║
║  .discipline/step1-input/01_Ejemplos_Reales.md               ║
║  .discipline/step1-input/02_Restricciones.md                 ║
║  .discipline/prompts/paso-1-all-prompts.md                   ║
╠══════════════════════════════════════════════════════════╣
║  Siguiente:                                             ║
║  Modo automatizado: /discipline-step1                        ║
║  Modo manual: abre paso-1-all-prompts.md y sigue orden  ║
╚══════════════════════════════════════════════════════════╝
`);
