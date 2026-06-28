---
name: discipline-step4
description: "Automate Discipline Loop Step 4: expand validated packets into executable slices with STEP_5_SLICE_PACKET, patch blocks, and paste-readies. Triggers on /discipline-step4 or 'run step 4' / 'ejecutar paso 4'."
---

# /discipline-step4 - Automatizar Paso 4 del pipeline Discipline Loop

Este skill ejecuta el Paso 4 completo: expande los slices del STEP_4_EXECUTION_PACKET validado en slices ejecutables con scope, contratos, criterios de aceptacion y DoD, genera el STEP_5_SLICE_PACKET para el primer slice listo, emite patch blocks, y deja los paste-readies listos para el Paso 5.

No requiere herramientas externas. Claude genera todo directamente.

## Lo que el usuario ve

1. El skill verifica que el STEP_4_EXECUTION_PACKET exista y tenga STATUS: validated
2. Lee todos los packets disponibles y el contexto del proyecto
3. Expande cada slice con scope detallado, contratos, criterios de aceptacion y complejidad
4. Genera el STEP_5_SLICE_PACKET para el primer slice listo
5. Emite patch blocks para task_plan.md, discipline.md y findings.md
6. Aplica patches, ensambla paste-readies, y reporta resumen

## Prerrequisitos

- Paso 2 completado (`STEP_4_EXECUTION_PACKET.md` con STATUS: validated)
- Node.js + npm (para correr los scripts de Discipline Loop)
- **Rol recomendado: Premium Reliable - Implementación o Premium Reliable - Trabajo Mecánico.** La expansión de slices es trabajo estructurado que no requiere Decisiones Críticas. Frontier-Budget - Implementación también es válido para slices simples si mantienes gates y review. Modelo concreto vigente: `09 - Referencia/01 - Registro Vivo de Modelos y Herramientas.md`.

---

## Implementacion interna

### Fase 0: Verificar inputs

Leer el contenido de estos archivos. Si el obligatorio no existe o no esta validado, detenerse con mensaje claro.

**Obligatorio:**
1. `.discipline/packets/STEP_4_EXECUTION_PACKET.md` - debe existir Y tener `STATUS: validated`

Si no existe:
```
Falta el STEP_4_EXECUTION_PACKET. Ejecuta /discipline-step2 primero.
Buscado en: .discipline/packets/STEP_4_EXECUTION_PACKET.md
```

Si existe pero no tiene `STATUS: validated` (sigue como borrador o no tiene STATUS):
```
El STEP_4_EXECUTION_PACKET no esta validado (STATUS actual: <status>).
Ejecuta /discipline-step2 para validar la arquitectura antes de expandir slices.
```

**Opcionales (leer si existen, enriquecen los slices):**
2. `.discipline/packets/UI_HANDOFF_PACKET.md` - descripciones de UI por pantalla y estado
3. `.discipline/packets/AI_IMPLEMENTATION_PACKET.md` - detalles de implementacion de features de IA
4. `.discipline/packets/STEP_3_STITCH_PACKET.md` - flujos de pantallas y navegacion
5. `.discipline/packets/STEP_2_ARCHITECTURE_PACKET.md` - contexto de arquitectura original

**Contexto del proyecto (leer siempre):**
6. `discipline.md` - switches, contratos, reglas operativas
7. `task_plan.md` - plan de slices actual y orden
8. `findings.md` - decisiones y riesgos documentados
9. `progress.md` - si existe, indica que slice ejecutar a continuacion

**Contexto adicional (leer si existen):**
10. `.discipline/step1-outputs/05_Data_Model.md` - modelo de datos detallado
11. `.discipline/step1-outputs/04_User_Stories.md` - user stories para criterios de aceptacion
12. `.discipline/step2-outputs/Paso2_01_Architecture_Core.md` - arquitectura core validada
13. `.discipline/step2-outputs/Paso2_02_Permissions_Security.md` - permisos y seguridad
14. `.discipline/step2-outputs/Paso2_03_Migrations_Backend.md` - migraciones y backend

### Fase 1: Expandir slices

**Contexto para la expansion:** Antes de expandir, Claude debe tener en mente:
- Los switches del proyecto y contratos de datos
- La arquitectura validada (componentes, dependencias, riesgos)
- Las user stories y flujos de UI (si existen)
- El orden y dependencias de slices definidos en el STEP_4_EXECUTION_PACKET
- Los riesgos documentados en findings.md

**Leer todos los packets disponibles.** Construir un mapa mental del proyecto completo antes de expandir.

**Para cada slice listado en el STEP_4_EXECUTION_PACKET:**

Expandir con el siguiente detalle:

1. **Goal**: Una frase que describe que logra este slice. Debe ser verificable (se puede demostrar que funciona).

2. **Scope IN**: Lista explicita de lo que SI se construye en este slice:
   - Archivos a crear o modificar
   - Componentes, hooks, utilidades
   - Endpoints o queries
   - Migraciones o cambios de schema
   - Tests minimos

3. **Scope OUT**: Lista explicita de lo que NO se construye en este slice (pero podria confundirse con que si):
   - Features relacionadas que van en otro slice
   - Optimizaciones que no son necesarias aun
   - Edge cases que se resuelven despues

4. **Contracts touched**: Que contratos de datos del STEP_4_EXECUTION_PACKET se usan o implementan en este slice:
   - Tablas / colecciones afectadas
   - Endpoints consumidos o creados
   - Types / interfaces definidas
   - RLS policies o security rules aplicadas

5. **UI states affected**: Si hay UI_HANDOFF_PACKET, listar que pantallas y estados se implementan en este slice. Si no hay UI, poner "N/A (LANE sin UI)" o "N/A (slice de backend)".

6. **Acceptance criteria**: Lista en formato checkbox de criterios verificables:
   ```
   - [ ] El usuario puede <accion especifica>
   - [ ] Los datos se persisten en <donde>
   - [ ] El estado <X> muestra <Y>
   - [ ] Error handling: si <condicion>, el usuario ve <mensaje>
   ```
   Minimo 3 criterios, maximo 8. Cada uno debe ser verificable manualmente o con test.

7. **Definition of Done (DoD)**: Condiciones tecnicas para considerar el slice completo:
   - Codigo commiteado y sin errores de lint
   - Tests pasando (si aplica al slice)
   - UI states implementados (normal + al menos 1 mas)
   - Sin TODOs criticos pendientes
   - Documentado en progress.md

8. **Dependencies**: Que slices deben estar completos antes de empezar este. Si es el primer slice (bootstrap), no tiene dependencias.

9. **Complexity estimate**: S (< 1 hora), M (1-3 horas), L (3-8 horas). Basado en:
   - S: Un archivo nuevo, cambio localizado, sin integraciones nuevas
   - M: Varios archivos, una integracion nueva, logica moderada
   - L: Multiples archivos, varias integraciones, logica compleja o edge cases

**Determinar orden de ejecucion.** Basandose en las dependencias:
- Slice 0 siempre es bootstrap (setup, config, schema, seed data)
- Slices sin dependencias se pueden paralelizar (documentar cuales)
- Slices con dependencias siguen el orden del grafo

**Generar READY_SLICES_BLOCK.** Ensamblar todos los slices expandidos en un bloque unico con formato consistente:

```markdown
# READY_SLICES_BLOCK

Total slices: <N>
Complexity breakdown: <X>S / <Y>M / <Z>L
Estimated total: <suma de estimaciones>

## Execution Order
1. Slice 0: <nombre> [S/M/L] - bootstrap
2. Slice 1: <nombre> [S/M/L] - depends on: 0
3. Slice 2: <nombre> [S/M/L] - depends on: 0 (parallelizable with 1)
...

---

## Slice 0: <nombre>
### Goal
...
### Scope IN
...
### Scope OUT
...
### Contracts touched
...
### UI states affected
...
### Acceptance criteria
...
### DoD
...
### Dependencies
...
### Complexity
...

---

## Slice 1: <nombre>
...
```

Guardar en: `.discipline/step4-outputs/READY_SLICES_BLOCK.md`
Reportar progreso por slice: `Slice N/M expanded: <nombre> [complexity]`

### Fase 2: Generar STEP_5_SLICE_PACKET

**Determinar cual slice va primero.** Criterio de seleccion:
1. Si `progress.md` existe e indica un slice especifico como siguiente, usar ese
2. Si no, usar el primer slice en el orden de ejecucion (tipicamente Slice 0 / bootstrap)

**Para el slice seleccionado, ensamblar el contexto completo de implementacion:**

```markdown
# STEP_5_SLICE_PACKET

SLICE: <numero y nombre>
COMPLEXITY: <S/M/L>
STATUS: ready

---

## Goal
<goal del slice>

## Scope
### IN
<scope IN detallado>

### OUT
<scope OUT detallado>

## Contracts
<contratos de datos relevantes, copiados del STEP_4_EXECUTION_PACKET con detalle completo>
<incluir types/interfaces, schemas de tablas, endpoints con request/response>

## UI Reference
<si hay UI_HANDOFF_PACKET: copiar las secciones de pantallas afectadas por este slice>
<incluir los 4 estados de cada pantalla afectada>
<si no hay UI: "N/A">

## AI Implementation Reference
<si hay AI_IMPLEMENTATION_PACKET y el slice toca features de IA: copiar secciones relevantes>
<si no: "N/A">

## Acceptance Criteria
<criterios de aceptacion en formato checkbox>

## DoD
<definition of done>

## Architecture Context
<extracto relevante del STEP_4_EXECUTION_PACKET: locks, guardrails, decisiones que afectan este slice>

## Known Risks
<riesgos de findings.md que aplican a este slice>

## Implementation Hints
<hints especificos para este slice basados en el analisis de arquitectura:>
<- que patron usar (ej: server actions, API routes, RPC)>
<- que templates del repo aprovechar>
<- que evitar (anti-patterns documentados en guardrails)>
```

Guardar en: `.discipline/packets/STEP_5_SLICE_PACKET.md`
Reportar: `STEP_5_SLICE_PACKET generado para Slice <N>: <nombre>`

### Fase 3: Generar patch blocks

**Evaluar que archivos del repo necesitan actualizarse y generar los bloques correspondientes.**

**1. TASK_PLAN_PATCH_BLOCK** (siempre se genera):

Actualizar la seccion Ready Slices de `task_plan.md` con los slices expandidos. Formato:

```markdown
TARGET_FILE: task_plan.md
PATCH_MODE: replace_section
ANCHOR: ## Ready Slices

CONTENT:
## Ready Slices

| # | Slice | Complexity | Dependencies | Status |
|---|---|---|---|---|
| 0 | <nombre> | S/M/L | none | ready |
| 1 | <nombre> | S/M/L | 0 | ready |
| 2 | <nombre> | S/M/L | 0 | ready |
...
```

Guardar en: `.discipline/patches/pending/TASK_PLAN_PATCH_BLOCK.md`

**2. DISCIPLINE_MD_PATCH_BLOCK** (solo si contratos necesitan actualizacion):

Si durante la expansion de slices se identificaron contratos que necesitan refinamiento (ej: un campo faltante, un endpoint no documentado, un type incompleto), generar el patch:

```markdown
TARGET_FILE: discipline.md
PATCH_MODE: replace_section
ANCHOR: <seccion especifica a actualizar>

CONTENT:
<contenido actualizado>
```

Solo generar este bloque si hay cambios concretos. No generar "por si acaso".

Guardar en: `.discipline/patches/pending/DISCIPLINE_MD_PATCH_BLOCK.md`

**3. FINDINGS_APPEND_BLOCK** (siempre se genera):

Documentar decisiones de scope tomadas durante la expansion:

```markdown
TARGET_FILE: findings.md
PATCH_MODE: append

CONTENT:
## Paso 4 - Expansion de slices (<fecha>)

### Decisiones de scope
- <decision 1: que se incluyo/excluyó y por que>
- <decision 2>
...

### Items diferidos
- <item que se pospuso para un slice posterior o post-MVP>
...

### Riesgos nuevos identificados
- <riesgo descubierto durante la expansion, si los hay>
...
```

Guardar en: `.discipline/patches/pending/FINDINGS_APPEND_BLOCK.md`

Reportar: `Patch blocks generados: <N> (TASK_PLAN, DISCIPLINE_MD?, FINDINGS)`

### Fase 4: Post-procesamiento

Aplicar patches pendientes:
```bash
npm run discipline:patch
```

Ensamblar paste-ready para el Paso 5:
```bash
npm run discipline:assemble -- --step 5
```

Esto genera `.discipline/paste-ready/paso-5-input.md` con el STEP_5_SLICE_PACKET y todo el contexto necesario para que el Paso 5 implemente el slice.

Registrar en run-log:
```bash
npm run discipline:log -- --step 4 --tool "Claude" --notes "Automated via /discipline-step4"
```

### Fase 5: Resumen y siguiente paso

Mostrar al usuario:

```
Paso 4 completado.

Slices expandidos: <N>
Complejidad total: <X>S / <Y>M / <Z>L (estimado: <total horas>h)

Slices listos:
<tabla con numero, nombre, complejidad, dependencias>

Primer slice preparado: Slice <N> - <nombre> [complexity]

Archivos generados:
- .discipline/step4-outputs/READY_SLICES_BLOCK.md
- .discipline/packets/STEP_5_SLICE_PACKET.md (Slice <N>)
- .discipline/patches/pending/ (<N> patch blocks)

Patches aplicados: <N>
- task_plan.md: Ready Slices actualizado
<si aplica:>
- discipline.md: Contratos actualizados
- findings.md: Decisiones y items diferidos

Paste-readies listos:
- .discipline/paste-ready/paso-5-input.md

Siguiente paso: /discipline-step5 (Implementar Slice <N>: <nombre>)
```

---

## Manejo de errores

- Si `STEP_4_EXECUTION_PACKET` no existe: detenerse con "Ejecuta /discipline-step2 primero."
- Si `STEP_4_EXECUTION_PACKET` no tiene STATUS validated: detenerse con mensaje indicando que ejecute /discipline-step2 para validar.
- Si el EXECUTION_PACKET no tiene slices definidos: detenerse con "El STEP_4_EXECUTION_PACKET no contiene slices. Revisa el output del Paso 2."
- Si `npm run discipline:patch` falla: reportar el error y continuar con el ensamblaje. Los patch blocks estan guardados en `.discipline/patches/pending/` y el operador puede aplicarlos manualmente.
- Si `npm run discipline:assemble` falla: reportar que archivos faltaron y sugerir revision. El STEP_5_SLICE_PACKET ya esta guardado en `.discipline/packets/` y se puede usar directamente.
- Si `npm run discipline:log` falla: reportar el error pero no bloquear. El log es informativo, no critico.
- Si hay inconsistencias entre el EXECUTION_PACKET y otros packets (ej: UI_HANDOFF_PACKET referencia pantallas que no cuadran con los slices): documentar la inconsistencia en FINDINGS_APPEND_BLOCK y resolverla usando el EXECUTION_PACKET como fuente de verdad para scope y los packets especializados como fuente de verdad para detalle.

---

## Reglas criticas

- Usar Extended Thinking para la expansion de slices. El valor de este paso es el scope preciso y los criterios de aceptacion verificables.
- No inventar slices que no esten en el STEP_4_EXECUTION_PACKET. Solo expandir los que ya existen. Si la expansion revela que un slice debe dividirse, documentar la razon y proponer la division, pero no aplicarla sin que el execution packet lo refleje.
- No cambiar el orden de slices sin justificacion fuerte documentada en findings.md.
- Los criterios de aceptacion deben ser verificables. "Funciona bien" no es un criterio. "El usuario puede crear un item y verlo en la lista" si lo es.
- Scope OUT es tan importante como Scope IN. Documentar explicitamente que NO va en cada slice evita scope creep durante la implementacion.
- Los contratos copiados al STEP_5_SLICE_PACKET deben ser exactos, no resumidos. El Paso 5 implementa directamente desde este packet.
- No recomendar optimizacion prematura en los slices. El bootstrap debe ser minimo y funcional.
- Los patch blocks deben ser exactos y pegables, no sugerencias narrativas.
- Si `progress.md` indica un slice diferente al primero, respetar esa indicacion. El operador puede estar retomando un pipeline parcial.
