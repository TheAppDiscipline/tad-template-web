---
name: discipline-step7
description: "Automate Discipline Loop Step 7: translate product decision into hardening backlog with PROD_HARDENING_PACKET, patch blocks, and paste-readies. Triggers on /discipline-step7 or 'run step 7' / 'ejecutar paso 7'."
---

# /discipline-step7 - Automatizar Paso 7 del pipeline Discipline Loop

Este skill ejecuta el Paso 7 completo: analiza el feedback de uso real, decide que areas de hardening activar, las convierte en slices concretos, produce el PROD_HARDENING_PACKET, emite patch blocks (incluyendo PROFILE: PROD), y deja los paste-readies listos para expandir hardening en Paso 4.

No requiere herramientas externas. Claude genera todo directamente usando Extended Thinking.

## Lo que el usuario ve

1. El skill verifica que existan los inputs del Paso 6
2. Pide confirmacion de la decision de producto (si no esta explicita)
3. Ejecuta 5 outputs secuencialmente con razonamiento profundo
4. Aplica patch blocks al repo y ensambla paste-readies
5. Reporta progreso y muestra un resumen con siguiente paso

## Prerrequisitos

- Paso 6 completado (`POST_DEPLOY_FEEDBACK_PACKET` en `.discipline/packets/`)
- Decision explicita de llevar la app a producto (vender o abrir al publico)
- Node.js + npm (para correr los scripts de Discipline Loop)
- **Rol requerido: Premium Reliable - Decisiones Críticas** con el razonamiento más fuerte disponible. Las decisiones de hardening son arquitecturales. No cerrar con roles mecánicos, free tiers ni Frontier-Budget sin review Premium.

---

## Implementacion interna

### Fase 0: Verificar inputs y decision de producto

**Mostrar advertencia de modelo:**

```
⚠️ Este paso requiere el rol Premium Reliable - Decisiones Críticas.
Verifica el modelo concreto vigente en el Registro Vivo (89).
No uses roles mecánicos, free tiers ni Frontier-Budget sin review Premium para este paso.
```

**Verificar inputs obligatorios:**

Leer estos archivos. Si el obligatorio no existe, detenerse con mensaje claro.

**Obligatorio:**
1. `.discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md`

Si no existe:
```
Falta el POST_DEPLOY_FEEDBACK_PACKET. Ejecuta /discipline-step6 primero.
El hardening debe basarse en feedback de uso real, no en suposiciones.
```

**Contexto del proyecto (leer siempre):**
2. `discipline.md`
3. `task_plan.md`
4. `findings.md`
5. `progress.md`

**Opcionales (leer si existen):**
6. `.discipline/paste-ready/paso-7-input.md` (preferido, ya ensamblado)
7. `.discipline/packets/STEP_4_EXECUTION_PACKET.md`
8. `.discipline/packets/DEPLOY_READINESS_PACKET.md`
9. `.discipline/step2-outputs/Paso2_02_Permissions_Security.md`

**Verificar decision de camino.** El Paso 7 ofrece **3 caminos** (ver `37 - Paso 7 - Evolucion a Producto` del vault). Buscar en `POST_DEPLOY_FEEDBACK_PACKET` o `paso-7-input.md` una decision explicita. Si no existe, preguntar:

```
El Paso 7 ofrece 3 caminos. ¿Cual eliges?

A) Manten como esta
   - La app funciona, no necesitas escalar, no vendes.
   - Sigue en PROFILE=LITE o FAMILY_SYNC.
   - Runbook de mantenimiento: nota 83 - Mantenimiento Solo.
   - No aplica hardening. Este skill se detiene aqui.

B) Escala dentro del vault
   - Vas a vender pequeno (Puerta C indie, hasta ~500 pagantes) o abrir publico.
   - Aplica hardening PROFILE=LAUNCH o PROD.
   - Este skill continua con analisis de feedback y decision de areas.

C) Sal del vault
   - Tu caso crecio mas alla del scope Discipline Loop (>500 pagantes, SaaS enterprise,
     compliance regulado, real-time colaborativo complejo).
   - Ver 85 - Limites de esta Guia §3 para recursos alternativos.
   - Este skill se detiene aqui; no aplica Discipline Loop hardening a ese scope.

¿Cual eliges? (A/B/C)
```

**Si A o C:** detenerse con mensaje claro y link a la nota correspondiente. No generar hardening packet.

**Si B:** continuar con Fase 1. Registrar detonante en el packet ("Razon de activar hardening: <motivo>").

No continuar sin decision explicita.

### Fase 1: Generar los 5 outputs

Usar Extended Thinking para cada output. El contexto incluye todos los archivos leidos en Fase 0 y todos los outputs ya generados.

**Output 1: Analisis de feedback** (`Paso7_01_Feedback_Analysis.md`)

Analizar el `POST_DEPLOY_FEEDBACK_PACKET` y producir:

1. Señales positivas: que funciona bien, que validan los usuarios, que genera satisfaccion
2. Fricciones reales: bugs, UX confuso, flujos rotos, errores frecuentes
3. Riesgos observados: seguridad, performance, datos, dependencias
4. Señales de negocio: demanda, disposicion a pagar, competencia, urgencia
5. Mapeo a areas de hardening: para cada señal, indicar cual de las 10 areas aplica

Las 10 areas son:
- 0: Migracion de datos y compatibilidad
- 1: Auth hardening
- 2: Permisos y audit
- 3: Observabilidad
- 4: Rate limiting
- 5: Billing
- 6: Legal y compliance
- 7: Testing
- 8: Deploy CI/CD
- 9: IA hardening (solo si AI_FEATURES=enabled)

Guardar en: `.discipline/step7-outputs/Paso7_01_Feedback_Analysis.md`
Reportar: `✓ Output 1/5: Analisis de feedback`

**Output 2: Decision de hardening** (`Paso7_02_Hardening_Decision.md`)

Para cada una de las 10 areas, decidir:

| Area | Decision | Fase | Justificacion |
|---|---|---|---|
| 0: Migracion | ACTIVATE / SKIP / DEFER | PROD-1/2/3 | evidencia del feedback |
| 1: Auth | ACTIVATE / SKIP / DEFER | PROD-1/2/3 | evidencia del feedback |
| ... | ... | ... | ... |

Criterios de decision:
- **ACTIVATE**: hay evidencia real de necesidad (feedback, riesgo observado, requisito legal)
- **SKIP**: no hay evidencia y no es requisito para el tipo de producto
- **DEFER**: hay indicios pero no es urgente; documentar trigger para reevaluar

Asignacion de fases:
- **PROD-1** (minimo para lanzar): auth hardening, audit de permisos, observabilidad basica, CI/CD
- **PROD-2** (primeros usuarios): rate limits, testing e2e, billing si cobra, analytics minimos
- **PROD-3** (escala): load testing, cost tracking, analytics avanzados, security audit profundo

Guardar en: `.discipline/step7-outputs/Paso7_02_Hardening_Decision.md`
Reportar: `✓ Output 2/5: Decision de hardening (<N> areas activadas)`

**Output 3: Slices de hardening** (`Paso7_03_Hardening_Slices.md`)

Para cada area ACTIVADA, generar 1-3 slices concretos:

```markdown
## Area <N>: <nombre>
### Fase: PROD-<1/2/3>

#### Slice H-<N>.1: <nombre del slice>
- Goal: <que logra>
- Scope IN: <que se construye>
- Scope OUT: <que no>
- Contracts touched: <tablas, endpoints, configs>
- Complexity: S / M / L
- Dependencies: <slices previos necesarios>

#### Slice H-<N>.2: <nombre>
...
```

Ordenar slices por fase y dentro de cada fase por dependencias.

Guardar en: `.discipline/step7-outputs/Paso7_03_Hardening_Slices.md`
Reportar: `✓ Output 3/5: Slices de hardening (<N> slices en <M> fases)`

**Output 4: PROD_HARDENING_PACKET**

Ensamblar el packet canonico con estas secciones:

```markdown
# PROD_HARDENING_PACKET

STATUS: ready
SOURCE_STEP: Paso 7
GENERATED: <fecha>

## Target phase
PROD-<1/2/3> (la fase inmediata a implementar)

## Rationale from feedback
<resumen de las señales que justifican el hardening>

## Hardening domains
| Area | Decision | Phase | Slices |
|---|---|---|---|
<tabla de las 10 areas con su decision>

## Mandatory slices (fase actual)
<lista de slices que entran ahora, ordenados por dependencia>

## Deferred items
<areas y slices que se postergaron con su trigger de reevaluacion>

## Lane impact
<cambios especificos para el LANE del proyecto>

## Gates to add
<gates adicionales que PROD requiere: e2e, security review, load test>

## SOPs to activate
<SOPs del vault que ahora aplican: SOP Seguridad, SOP Testing, etc.>
```

Guardar en: `.discipline/packets/PROD_HARDENING_PACKET.md`
Reportar: `✓ Output 4/5: PROD_HARDENING_PACKET`

**Output 5: Patch blocks**

Generar los 3 bloques:

1. **DISCIPLINE_MD_PATCH_BLOCK** — cambiar PROFILE a PROD y actualizar secciones relevantes:

```markdown
TARGET_FILE: discipline.md
PATCH_MODE: replace_section
ANCHOR: ## 0) Profile

CONTENT:
## 0) Profile

PROFILE: PROD
<resto de switches sin cambiar>
```

Si el hardening agrega gates, rate limits o contratos nuevos, generar patches adicionales para las secciones correspondientes de discipline.md.

2. **TASK_PLAN_PATCH_BLOCK** — agregar slices de hardening a Ready Slices:

```markdown
TARGET_FILE: task_plan.md
PATCH_MODE: replace_section
ANCHOR: ## 4) Ready Slices

CONTENT:
## 4) Ready Slices

### Hardening - PROD-<fase>

| # | Slice | Complexity | Dependencies | Status |
|---|---|---|---|---|
| H-0.1 | <nombre> | M | none | ready |
| H-1.1 | <nombre> | M | H-0.1 | ready |
...
```

3. **FINDINGS_APPEND_BLOCK** — documentar decisiones:

```markdown
TARGET_FILE: findings.md
PATCH_MODE: append

CONTENT:
## Paso 7 - Hardening decision (<fecha>)

### Areas activadas
- <area>: <justificacion>

### Areas diferidas
- <area>: <trigger para reevaluar>

### Areas descartadas
- <area>: <por que no aplica>

### Riesgos aceptados
- <riesgo que se acepta conscientemente>
```

Guardar en: `.discipline/patches/pending/` (un archivo por bloque)
Reportar: `✓ Output 5/5: Patch blocks`

### Fase 2: Post-procesamiento

Aplicar patches pendientes:
```bash
npm run discipline:patch
```

Ensamblar paste-ready para hardening en Paso 4:
```bash
npm run discipline:assemble -- --step 4-hardening
```

Registrar en run-log:
```bash
npm run discipline:log -- --step 7 --tool "Claude Extended Thinking" --notes "Automated via /discipline-step7"
```

### Fase 3: Resumen y siguiente paso

Mostrar al usuario:

```
Paso 7 completado.

Decision: PROFILE cambiado a PROD

Areas activadas:
<lista con fase asignada>

Areas diferidas:
<lista con trigger>

Slices de hardening generados: <N>
- PROD-1: <N> slices
- PROD-2: <N> slices
- PROD-3: <N> slices

Archivos generados:
- .discipline/step7-outputs/ (3 analisis)
- .discipline/packets/PROD_HARDENING_PACKET.md
- Patch blocks aplicados: 3

Paste-readies listos:
- .discipline/paste-ready/paso-4-hardening.md

Siguiente paso: /discipline-step4 para expandir los slices de hardening
```

---

## Manejo de errores

- Si `POST_DEPLOY_FEEDBACK_PACKET` no existe: detenerse con "Ejecuta /discipline-step6 primero."
- Si el usuario no tiene decision de producto: detenerse con opciones claras (seguir en FAMILY_SYNC, buscar mas feedback, etc.)
- Si `npm run discipline:patch` falla: reportar el error y continuar con el ensamblaje. Los patch blocks estan en `.discipline/patches/pending/` para aplicacion manual.
- Si `npm run discipline:assemble` falla: reportar que archivos faltaron. El PROD_HARDENING_PACKET ya esta en `.discipline/packets/`.
- Si `npm run discipline:log` falla: reportar pero no bloquear.
- Si el feedback no tiene suficiente evidencia para decidir areas: documentar la incertidumbre en findings.md y recomendar mas uso real antes de endurecer.

---

## Reglas criticas

- Usar Extended Thinking para todos los outputs. Las decisiones de hardening son arquitecturales.
- No activar areas sin evidencia real del feedback. "Por si acaso" no es justificacion.
- No endurecer todo de golpe. Asignar fases PROD-1/2/3 y empezar solo por la fase inmediata.
- Cada area activada debe convertirse en slices concretos con scope, contratos y DoD.
- Los slices de hardening entran al pipeline normal (Paso 4 → Paso 5). No son atajos fuera del sistema.
- No inventar requisitos de billing, legal o compliance que el usuario no haya mencionado.
- El DISCIPLINE_MD_PATCH_BLOCK debe cambiar PROFILE a PROD. Esto no es opcional si se activa hardening.
- Los patch blocks deben ser exactos y pegables, no sugerencias narrativas.
- Si AI_FEATURES=none, saltar Area 9 (IA hardening) completamente.
