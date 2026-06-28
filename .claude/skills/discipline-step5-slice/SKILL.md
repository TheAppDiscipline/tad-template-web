---
name: discipline-step5-slice
description: "Cierra un slice del Paso 5 con Slice Loop completo: gate verde, Repair Budget enforcement, SLICE_COMPLETION_PACKET emitido, run-log actualizado. Triggers on /discipline-step5-slice or 'cerrar slice' / 'close slice'."
---

# /discipline-step5-slice - Cerrar un slice del Paso 5 siguiendo Slice Loop

Este skill orquesta el cierre formal de un slice ya implementado: corre el gate, aplica Repair Budget si falla (max 3 intentos con escalación de modelo), genera SLICE_COMPLETION_PACKET, registra en run-log.md, y prepara el siguiente paste-ready (paso-4-reentry o paso-6-input).

NOTA: el Paso 5 (implementacion) sigue siendo iterativo y manual en el daily driver. Este skill NO implementa el slice; solo lo cierra. Si necesitas escribir codigo, usa Claude Code CLI o Cursor directamente.

## Lo que el usuario ve

1. El skill verifica DoR del slice (Definition of Ready en STEP_5_SLICE_PACKET).
2. Corre `npm run gate` (o variant del lane).
3. Si falla, aplica Repair Budget: 2 reintentos sin escalar; un 3er intento (modelo más fuerte) solo con razón documentada de por qué más razonamiento puede cambiar el diagnóstico; stop duro después.
4. Cuando gate verde, genera SLICE_COMPLETION_PACKET con todos los campos.
5. Si batch listo para deploy, tambien DEPLOY_READINESS_PACKET.
6. Registra run en `.discipline/run-log.md`.
7. Genera paste-ready para siguiente paso.

## Prerrequisitos

- `STEP_5_SLICE_PACKET.md` existe en `.discipline/packets/` con DoR claro.
- Codigo del slice ya implementado (no es trabajo de este skill).
- `discipline.md`, `task_plan.md`, `findings.md`, `progress.md` actualizados.
- Repo con `.discipline/` y scripts `discipline:*` disponibles.

---

## Implementacion interna

### Fase 0: Verificar DoR

Leer `.discipline/packets/STEP_5_SLICE_PACKET.md`. Confirmar:
- Goal definido
- Scope IN/OUT explicito
- Contracts (data model, API/IO, interaction surface)
- Acceptance criteria verificables
- Risks / edge cases listados

Si falta DoR, abortar:
```
DoR incompleto en STEP_5_SLICE_PACKET. Vuelve a /discipline-step4 para refinar la spec antes de cerrar el slice.

Falta: <list de campos>
```

### Fase 1: Verificar pre-condiciones

- `.discipline/patches/pending/` esta vacio (si hay patches, aplicar primero con `npm run discipline:patch`).
- Cambios en repo coinciden con scope del slice (revisar `git diff --stat`).
- Archivos tocados estan dentro del scope IN del slice.

Si patches pendientes:
```bash
npm run discipline:patch
```

Si scope desvio detectado:
```
El diff incluye archivos fuera del scope IN del slice. Revisar:
<lista archivos>

Opciones:
1. Si son legitimos, actualizar STEP_5_SLICE_PACKET §Scope IN.
2. Si son drift, revertir y mantener slice acotado.
```

### Fase 2: Correr gate

Ejecutar el gate del lane:
- Web/Desktop: `npm run gate`
- Mobile: `npm run gate` (lint + tsc + tests + checks)
- Extension: `npm run gate`

Capturar exit code y output completo.

Si `AI_FEATURES=enabled` (leido de discipline.md):
```bash
npm run ai:smoke
npm run ai:eval
```

### Fase 3: Repair Budget si gate falla

**Política (resumen de NN 10 Repair Budget; norma completa en `discipline.md` / vault `02 - Discipline Loop` §Grupo C):** 2 intentos con la misma signature y sin cambio material (evidencia, contexto, hipótesis o estrategia) = stop temprano; **escalar de modelo habilita un único tercer intento solo cuando documentas en `progress.md §Open Errors` (o `run-log.md`) por qué más capacidad de razonamiento puede cambiar el diagnóstico** (no es pase automático), que es lo que hace el Intento 3 de abajo; si la firma apunta a spec, arquitectura, datos o entorno, vuelve al paso productor (Paso 2/4); 3 fallos del mismo gate = stop duro, sin excepción.

**Intento 1 (gate falla, primera vez):**
1. Analizar firma del error (TypeScript code, ESLint rule, test name).
2. Buscar fix directo en los Errores Comunes del Gate del vault.
3. Si match, aplicar fix manualmente (usuario lo aprueba).
4. Reintentar: `npm run gate`.

**Intento 2 (mismo error o nuevo):**
1. Pegar error completo + contexto del slice al modelo actual.
2. Pedir fix puntual sin agregar features ni dependencias.
3. Reintentar.

**Intento 3 (escalar modelo, solo con razón documentada):**
1. Si los 2 intentos previos fallaron con la misma signature, **documenta primero en `progress.md §Open Errors` por qué más capacidad de razonamiento puede cambiar el diagnóstico** (si no puedes, el problema es de spec/arquitectura/datos/entorno: para y vuelve al paso productor). Luego escalar del rol actual a `Premium Reliable - Decisiones Críticas`, o activar el modo de razonamiento fuerte del modelo vigente.
2. Pegar error + cambios intentados + por que cada uno fallo.
3. Reintentar.

**Stop duro despues del 3er fallo:**
```
Repair Budget agotado (3 fallos sin info nueva).

Errores en orden:
1. <signature 1>
2. <signature 2>
3. <signature 3>

Causas posibles:
- Spec del slice incompleta o contradictoria, vuelve a /discipline-step4 con `paso-4-reentry.md`.
- Cambio de arquitectura necesario, vuelve a /discipline-step2.
- Bug estructural en deps, revisar `npm audit`.

Acciones:
1. Documentar en progress.md §Open Errors los 3 intentos y signatures.
2. Decidir: retry con info nueva, o escalar a Paso 2/4.

NO reintentar este skill hasta tener info nueva.
```

Registrar el repair budget usado en SLICE_COMPLETION_PACKET (`REPAIR_BUDGET_USED: N/3`).

### Fase 4: Manual verification

El gate verde no garantiza que el slice funciona desde el lado del usuario. Pedir verificacion manual:

```
Gate verde. Manual verification obligatoria antes de cerrar el slice:

1. Happy path, ¿la accion principal funciona?
2. Failure path si aplica, ¿el error se muestra al usuario sin crash?
3. Si FAMILY_SYNC, smoke en 2 dispositivos.
4. Si UI tiene estados loading/empty/error, ¿se ven correctamente?

Confirma con "manual verification OK" cuando termines, o reporta lo que fallo.
```

Si manual verification falla, no cerrar el slice. Volver a Fase 2 con info nueva.

### Fase 5: Generar SLICE_COMPLETION_PACKET

Escribir `.discipline/packets/SLICE_COMPLETION_PACKET.md` con la estructura canonica del vault (Paso 5 - Implementación, estructura mínima de SLICE_COMPLETION_PACKET):

```markdown
## SLICE_COMPLETION_PACKET

### Slice
- <id y nombre>

### Outcome
- done | partial | blocked

### Scope delivered
- <que si quedo implementado>

### Files touched
- <archivo 1>
- <archivo 2>

### Gates passed
- npm run gate
- <otros smoke/evals si aplica>

### Manual verification
- happy path: OK
- failure path: OK / N/A
- dispositivos: <lista>

### Repair budget used
- N/3 (con signatures de errores si N>0)

### Open issues
- <none o lista>

### Next recommendation
- <siguiente slice o volver a otro paso>

### Deploy signal
- not_ready | ready_for_preview | ready_for_production_candidate
```

### Fase 6: Deploy signal y posibles outputs

Si `Deploy signal != not_ready`, generar tambien `.discipline/packets/DEPLOY_READINESS_PACKET.md` con la estructura del vault (Paso 5 - Implementación, estructura mínima de DEPLOY_READINESS_PACKET).

Si surgio info nueva:
- `TASK_PLAN_PATCH_BLOCK` para reordenar slices o agregar uno nuevo.
- `FINDINGS_APPEND_BLOCK` para riesgos/decisiones nuevas.
- `DISCIPLINE_MD_PATCH_BLOCK` solo si cambia constitucion (raro).

### Fase 7: Actualizar progress.md y run-log

```bash
npm run discipline:progress      # actualiza progress.md desde SLICE_COMPLETION_PACKET
npm run discipline:log -- --step 5 --tool "/discipline-step5-slice" --notes "<slice id> closed, repair=<N>/3, deploy=<signal>"
```

Si watcher esta corriendo, estos pasos son automaticos. Si no, ejecutarlos manualmente.

### Fase 8: Generar paste-ready siguiente

```bash
npm run discipline:assemble
```

El assembler decide automaticamente:
- `paso-4-reentry.md` si `Deploy signal: not_ready` (mas slices por hacer).
- `paso-6-input.md` si `Deploy signal: ready_for_preview` o `ready_for_production_candidate`.

Reportar al usuario que paste-ready quedo listo y abrir el archivo.

### Fase 9: Resumen

```
Paso 5 slice cerrado.

Slice: <id>
Outcome: done | partial
Repair budget: <N>/3
Deploy signal: <signal>

Archivos generados:
- SLICE_COMPLETION_PACKET.md
- DEPLOY_READINESS_PACKET.md (si aplica)

Siguiente: <pega `paste-ready/paso-X-input.md` en /discipline-stepX o continua loop con /discipline-step4>
```

---

## Manejo de errores

- Si STEP_5_SLICE_PACKET no existe: abortar y redirigir a /discipline-step4.
- Si patches pendientes y `discipline:patch` falla: parar, reportar conflicto, redirigir a la guía Aplicar Patch Blocks del vault.
- Si gate falla con error fuera de los 20 listados en 81a: aplicar Repair Budget normalmente.
- Si manual verification se reporta como fallida: actualizar SLICE_COMPLETION_PACKET con `Outcome: partial` o `blocked` y dejar slice abierto para nueva iteracion.

---

## Reglas criticas

- Repair Budget no se relaja: 3 intentos sin info nueva = stop duro.
- Manual verification no es opcional. Gate verde no implica slice done.
- No tocar codigo de OTRO slice mientras este corre.
- No actualizar `discipline.md` desde este skill (eso es Paso 2).
- Si surgen 5+ open issues, el slice probablemente estaba mal definido, vuelve a Paso 4.
- El skill no escribe codigo del slice. Solo lo cierra.
- Tiempo objetivo: 5-15 min para cerrar un slice ya implementado.
