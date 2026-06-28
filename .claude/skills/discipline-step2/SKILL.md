---
name: discipline-step2
description: "Automate Discipline Loop Step 2: validate architecture with extended thinking, produce validated STEP_4_EXECUTION_PACKET, patch blocks, and paste-readies. Triggers on /discipline-step2 or 'run step 2' / 'ejecutar paso 2'."
---

# /discipline-step2 - Automatizar Paso 2 del pipeline Discipline Loop

Este skill ejecuta el Paso 2 completo: valida la arquitectura del MVP, produce el STEP_4_EXECUTION_PACKET con STATUS: validated, emite patch blocks para los archivos del repo, y deja los paste-readies listos para los pasos siguientes.

No requiere herramientas externas. Claude genera todo directamente usando Extended Thinking.

## Lo que el usuario ve

1. El skill verifica que existan los inputs del Paso 1
2. Ejecuta 6 outputs secuencialmente con razonamiento profundo
3. Aplica patch blocks al repo y ensambla paste-readies
4. Reporta progreso y muestra un resumen con siguiente paso

## Prerrequisitos

- Paso 1 completado (packets en `.discipline/packets/`)
- `STEP_2_ARCHITECTURE_PACKET.md` debe existir en `.discipline/packets/`
- `STEP_4_EXECUTION_PACKET.borrador.md` debe existir en `.discipline/packets/`
- Node.js + npm (para correr los scripts de Discipline Loop)
- **Rol requerido: Premium Reliable - Decisiones Críticas** con el razonamiento más fuerte disponible. Resuelve el modelo concreto vigente en `09 - Referencia/01 - Registro Vivo de Modelos y Herramientas.md`. Puedes usar Frontier-Budget sólo para borrador previo; el cierre arquitectónico requiere Premium.

---

## Implementacion interna

### Fase 0: Verificar inputs y modelo

**Antes de verificar archivos, mostrar esta advertencia al operador:**

```
⚠️ Este paso requiere el rol Premium Reliable - Decisiones Críticas.
Verifica el modelo concreto vigente en el Registro Vivo (89) antes de cerrar arquitectura.
No uses roles mecánicos, free tiers ni Frontier-Budget sin review Premium para este cierre.
```

Continuar solo despues de mostrar la advertencia.

Leer el contenido de estos archivos. Si alguno obligatorio no existe, detenerse con mensaje claro.

**Obligatorios:**
1. `.discipline/packets/STEP_2_ARCHITECTURE_PACKET.md`
2. `.discipline/packets/STEP_4_EXECUTION_PACKET.borrador.md`

Si falta alguno:
```
Faltan inputs del Paso 1. Ejecuta /discipline-step1 primero.
Faltante(s): <lista de archivos que faltan>
```

**Opcionales (leer si existen):**
3. `.discipline/step1-outputs/03_PRD.md`
4. `.discipline/step1-outputs/04_User_Stories.md`
5. `.discipline/step1-outputs/05_Data_Model.md`
6. `.discipline/step1-outputs/08_Architecture_Switches.md`
7. `.discipline/step1-outputs/09_Export_for_DisciplineLoop.md`
8. `.discipline/step1-outputs/07_Events_and_Notifications.md`

**Contexto del proyecto (leer siempre):**
9. `discipline.md`
10. `task_plan.md`
11. `findings.md`

### Fase 1: Generar los 6 outputs

Usar Extended Thinking para cada output. Incluir "think hard about this" internamente para activar razonamiento profundo.

El contexto para cada output incluye:
- Todos los archivos leidos en Fase 0
- Todos los outputs ya generados en este paso

**Output 1: Arquitectura core** (`Paso2_01_Architecture_Core.md`)

Analizar y producir:
1. Validacion de arquitectura: backend, auth mode, sync mode, collab mode. Si algo esta mal, recomendar cambio con justificacion.
2. Arquitectura minima correcta: diagrama de componentes (texto), superficie principal segun lane, backend, auth, sync.
3. Dependencias entre slices: orden, bloqueantes, paralelizables.
4. Que NO construir en el MVP: features prematuras, infra innecesaria.

Guardar en: `.discipline/step2-outputs/Paso2_01_Architecture_Core.md`
Reportar: `Output 1/6: Arquitectura core`

**Output 2: Permisos y seguridad** (`Paso2_02_Permissions_Security.md`)

Analizar y producir:
1. Permisos: roles suficientes, operaciones por rol, RLS policies / security rules / validaciones minimas.
2. Riesgos de filtracion de datos: escenarios cross-space, queries sin filtro, endpoints expuestos.
3. Auth edge cases: link expirado, sesion multiple, logout parcial (omitir si AUTH=NONE).
4. Recomendaciones minimas de seguridad MVP.

Guardar en: `.discipline/step2-outputs/Paso2_02_Permissions_Security.md`
Reportar: `Output 2/6: Permisos y seguridad`

**Output 3: Migraciones y backend** (`Paso2_03_Migrations_Backend.md`)

Analizar y producir:
1. Migraciones: SQL si Supabase (partiendo de templates), colecciones si Firebase, persistencia local si LOCAL_ONLY. Indices, FKs, constraints.
2. Datos seed / bootstrap: datos iniciales, primer usuario, space inicial.
3. Edge cases de datos: huerfanos, cascadas, soft deletes, conflictos LWW.
4. Queries criticas: las 3-5 mas frecuentes, indices necesarios, joins complejos.

Guardar en: `.discipline/step2-outputs/Paso2_03_Migrations_Backend.md`
Reportar: `Output 3/6: Migraciones y backend`

**Output 4: Riesgos y decisiones finales** (`Paso2_04_Risks_Final.md`)

Analizar y producir:
1. Top 5 riesgos tecnicos: que, probabilidad, impacto, mitigacion.
2. Decisiones que tomar ahora: las que posponer costaria refactors.
3. Decisiones que postponer: las que se aclaran despues de 2-3 slices.
4. Validacion final de slices: orden, dividir, combinar, bootstrap correcto.
5. Resumen ejecutivo: maximo 10 lineas.
6. Decisiones dificiles de revertir.

Guardar en: `.discipline/step2-outputs/Paso2_04_Risks_Final.md`
Reportar: `Output 4/6: Riesgos y decisiones`

**Output 5: STEP_4_EXECUTION_PACKET validado**

Consolidar todo lo validado en el formato canonico con 12 secciones:
1. PRODUCT SUMMARY
2. MVP BOUNDARY
3. ARCHITECTURE LOCKS
4. DATA / ACCESS / SYNC CONTRACTS
5. SLICE DRAFT
6. SLICE ORDER / DEPENDENCIES
7. BOOTSTRAP REQUIREMENTS
8. PROVIDER IMPACT
9. AI SURFACE SUMMARY
10. INTERACTION SURFACE SUMMARY
11. RISKS / EDGE CASES
12. IMPLEMENTATION GUARDRAILS

Agregar `STATUS: validated` al inicio.

Guardar en: `.discipline/packets/STEP_4_EXECUTION_PACKET.md`
Renombrar `.discipline/packets/STEP_4_EXECUTION_PACKET.borrador.md` a `.discipline/packets/STEP_4_EXECUTION_PACKET.borrador.superseded.md`
Reportar: `Output 5/6: STEP_4_EXECUTION_PACKET (validated)`

**Output 6: Patch blocks del repo**

Generar los bloques que correspondan:

1. `DISCIPLINE_MD_PATCH_BLOCK` - solo si cambiaron switches, contratos o reglas operativas
2. `TASK_PLAN_PATCH_BLOCK` - para reflejar orden, division o combinacion real de slices
3. `FINDINGS_APPEND_BLOCK` - para registrar decisiones, riesgos aceptados y postergados

Cada bloque debe usar TARGET_FILE, PATCH_MODE, ANCHOR y CONTENT.

Guardar en: `.discipline/patches/pending/` (un archivo por bloque)
Reportar: `Output 6/6: Patch blocks`

### Fase 2: Post-procesamiento

Aplicar patches pendientes:
```bash
npm run discipline:patch
```

Ensamblar paste-readies para los siguientes pasos:

```bash
npm run discipline:assemble -- --step 4
```

Si `AI_FEATURES=enabled` en discipline.md:
```bash
npm run discipline:assemble -- --step 2.5
```

Si LANE no es BACKEND ni CLI (tiene UI):
```bash
npm run discipline:assemble -- --step 3
```

Registrar en run-log:
```bash
npm run discipline:log -- --step 2 --tool "Claude Extended Thinking" --notes "Automated via /discipline-step2"
```

### Fase 3: Resumen y siguiente paso

Mostrar al usuario:

```
Paso 2 completado.

Outputs generados:
- Paso2_01_Architecture_Core.md
- Paso2_02_Permissions_Security.md
- Paso2_03_Migrations_Backend.md
- Paso2_04_Risks_Final.md
- STEP_4_EXECUTION_PACKET.md (STATUS: validated)
- Patch blocks aplicados: <N>

Paste-readies listos:
- .discipline/paste-ready/paso-4-input.md
<si aplica:>
- .discipline/paste-ready/paso-2.5-input.md
- .discipline/paste-ready/paso-3-input.md

Siguiente paso: <determinar segun config>
- Si AI_FEATURES=enabled: /discipline-step2.5 o Paso 2.5 manual
- Si hay UI (LANE != BACKEND, CLI): Paso 3 (Stitch)
- Si no: Paso 4 (Slices ejecutables)
```

---

## Manejo de errores

- Si `STEP_2_ARCHITECTURE_PACKET` no existe: detenerse con "Ejecuta /discipline-step1 primero."
- Si `npm run discipline:patch` falla: reportar el error y continuar con el ensamblaje. El operador puede aplicar patches manualmente.
- Si `npm run discipline:assemble` falla: reportar que archivos faltaron y sugerir revision.
- Si un output es inconsistente con los anteriores: corregir antes de continuar (mismo patron que Output 8 del Paso 1).

---

## Reglas criticas

- Usar Extended Thinking para outputs 1-5. El valor de este paso es el razonamiento profundo.
- No inventar logica de negocio. Si falta informacion, documentar el supuesto en findings.md.
- No cambiar el lane ni el stack sin justificacion fuerte.
- No recomendar optimizacion prematura.
- Los patch blocks deben ser exactos y pegables, no sugerencias narrativas.
- El STEP_4_EXECUTION_PACKET validado reemplaza cualquier version borrador anterior.
