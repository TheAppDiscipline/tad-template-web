---
name: discipline-step3
description: "Automate Discipline Loop Step 3: prepare context for Stitch, orchestrate UI generation via Stitch MCP or manual Stitch session, and produce UI_HANDOFF_PACKET. Triggers on /discipline-step3 or 'run step 3' / 'ejecutar paso 3'."
---

# /discipline-step3 - Automatizar Paso 3 del pipeline Discipline Loop

Este skill prepara el contexto para Stitch, orquesta la generacion de pantallas (via Stitch MCP si esta disponible, o guiando al operador en stitch.withgoogle.com), y produce el UI_HANDOFF_PACKET a partir de lo que Stitch genero.

**Stitch es la herramienta primaria de este paso.** El skill no reemplaza a Stitch; lo complementa haciendo el antes (preparar contexto) y el despues (ensamblar packet y paste-readies).

## Lo que el usuario ve

1. El skill verifica que el LANE tenga UI (no BACKEND ni CLI)
2. Prepara el prompt optimizado para Stitch con adaptaciones por lane
3. Si Stitch MCP esta disponible: genera pantallas automaticamente
4. Si no: guia al operador para usar stitch.withgoogle.com y reportar resultados
5. Ensambla el UI_HANDOFF_PACKET desde la salida de Stitch
6. Ensambla paste-readies y reporta siguiente paso

## Prerrequisitos

- Paso 1 completado (packets en `.discipline/packets/`)
- Paso 2 completado (`STEP_4_EXECUTION_PACKET.md` con STATUS: validated)
- `STEP_3_STITCH_PACKET.md` debe existir en `.discipline/packets/`
- Node.js + npm (para correr los scripts de Discipline Loop)
- **Herramienta primaria: Google Stitch** (stitch.withgoogle.com, gratis, 350 gen/mes)
- **Stitch no expone un MCP server oficial instalable:** su handoff es manual (exporta desde stitch.withgoogle.com y pega el resultado). Si tu entorno ya tiene un MCP de Stitch configurado, el skill lo detecta y lo usa; si no, opera en modo guiado.

---

## Implementacion interna

### Fase 0: Verificar inputs y LANE

**Verificar LANE.** Leer `discipline.md` y extraer el valor de LANE.

Si LANE es BACKEND o CLI:
```
LANE={lane} no tiene UI. Paso 3 no aplica. Ve al Paso 4: /discipline-step4
```
Detenerse.

**Verificar inputs:**

**Obligatorio (uno de los dos):**
1. `.discipline/paste-ready/paso-3-input.md` (preferido, ya ensamblado)
2. `.discipline/packets/STEP_3_STITCH_PACKET.md` (fuente directa)

Si ninguno existe:
```
Falta el STEP_3_STITCH_PACKET. Ejecuta /discipline-step1 primero.
```

**Contexto del proyecto (leer siempre):**
3. `discipline.md` — switches, contratos, reglas
4. `.discipline/packets/STEP_4_EXECUTION_PACKET.md` — arquitectura validada, slices, contratos de datos
5. `task_plan.md`
6. `findings.md`

**Opcionales (leer si existen):**
7. `.discipline/step1-outputs/06_UI_States.md` — estados de UI del Paso 1
8. `.discipline/step1-outputs/04_User_Stories.md` — user stories para entender flujos
9. `.discipline/packets/AI_IMPLEMENTATION_PACKET.md` — si hay features IA que afectan UI

**Detectar Stitch MCP.** Verificar si el MCP de Stitch esta disponible:
- Buscar `stitch` en la lista de MCPs configurados
- Si esta disponible: modo automatico (Fase 1A)
- Si no: modo guiado (Fase 1B)

### Fase 1A: Generacion con Stitch MCP (si disponible)

Si Stitch MCP esta configurado, usarlo directamente.

**Preparar el prompt para Stitch.** Construir el prompt incluyendo:

1. Nombre y descripcion de la app (de discipline.md)
2. Pantallas P0 listadas en el STITCH_PACKET
3. Flujos principales de usuario
4. Adaptaciones por LANE:

Para WEB:
```
Contexto: app web responsive (mobile-first).
Patrones: top nav o sidebar, responsive breakpoints, PWA install prompt.
```

Para MOBILE:
```
Contexto: app movil nativa (iOS/Android).
Patrones: bottom tabs si hay secciones, stack navigation, safe areas, haptic feedback.
```

Para DESKTOP:
```
Contexto: app de escritorio (Mac/Windows/Linux).
Patrones: window chrome, sidebar, menu bar, drag areas.
```

Para WEB_SSR:
```
Contexto: app web con SSR (Next.js).
Patrones: same as web, pero considerar que el primer render es del servidor.
```

**Llamar al MCP.** Usar las herramientas de Stitch:
- `stitch_generate_screens` con el prompt preparado
- `stitch_get_design_system` para leer el sistema de diseno generado
- `stitch_get_screens` para leer las pantallas generadas

**Verificar resultado.** Para cada pantalla P0:
- Verificar que exista en la salida de Stitch
- Verificar que cubra los 4 estados (normal, loading, empty, error) o documentar cuales faltan

Reportar: `✓ Stitch genero <N> pantallas via MCP`

Ir a Fase 2.

### Fase 1B: Generacion guiada (si Stitch MCP no esta disponible)

Si Stitch MCP no esta disponible, guiar al operador.

**Preparar el prompt optimizado para Stitch.** Mismo contenido que Fase 1A, pero formateado para copiar y pegar.

Mostrar al operador:

```
Stitch MCP no esta disponible. Usa Stitch manualmente:

1. Abre stitch.withgoogle.com
2. Copia y pega este prompt:

---
<prompt preparado con nombre de app, pantallas P0, flujos, adaptaciones por LANE>
---

3. Genera las pantallas P0
4. Usa el boton Play para navegar el flujo
5. Exporta el codigo (React + Tailwind recomendado para Web)
6. Cuando termines, dime:
   - ¿Cuantas pantallas se generaron?
   - ¿Cubren los flujos principales?
   - ¿Hay algo que Stitch no pudo generar bien?
```

Esperar la respuesta del operador. Si reporta problemas con alguna pantalla, documentar en findings.md.

Reportar: `✓ Operador completo Stitch manualmente: <N> pantallas`

### Fase 2: Ensamblar UI_HANDOFF_PACKET

**Si se uso Stitch MCP:** leer las pantallas generadas via `stitch_get_screens` y el design system via `stitch_get_design_system`.

**Si se uso Stitch manual:** pedir al operador que describa brevemente cada pantalla generada, o que pegue la URL de la sesion de Stitch.

**Para cada pantalla P0, documentar los 4 estados:**

Estos son obligatorios. Si Stitch no genero alguno explicitamente, inferirlo de la pantalla normal y los contratos del proyecto:

1. **normal** — layout, componentes, accion primaria, acciones secundarias, variantes por rol
2. **loading** — skeleton/spinner, que ya es visible vs que espera datos
3. **empty** — mensaje orientado a accion, ilustracion sugerida, distinguir "nuevo" vs "sin resultados"
4. **error** — mensaje user-friendly, accion de recovery, error boundaries

**Aplicar adaptaciones por LANE** (obligatorias):
- WEB: responsive notes, PWA considerations
- MOBILE: safe areas, navigation patterns, gestos
- DESKTOP: window chrome, IPC boundaries, menu bar
- WEB_SSR: SSR vs client rendering, hydration boundaries

**Ensamblar el packet.** Formato canonico:

```markdown
# UI_HANDOFF_PACKET

LANE: <lane>
SCREENS: <N total>
GENERATED: <fecha>
SOURCE: Stitch <MCP | manual>

---

## SCREEN: <nombre>

### States

#### normal
- Structure: <layout>
- Main components: <lista>
- Primary action: <CTA>
- Notes for implementation: <hints>

#### loading
...

#### empty
...

#### error
...

---

## Flow Notes

### Navigation Map
<como se conectan las pantallas>

### Shared Components
<componentes que se repiten>

### Interaction Patterns
<patrones por LANE>

### Accessibility Notes
<labels, contrast, focus, screen reader>
```

Guardar en: `.discipline/packets/UI_HANDOFF_PACKET.md`
Reportar: `✓ UI_HANDOFF_PACKET ensamblado con <N> pantallas`

**Opcionalmente, generar DESIGN_MD_READY_BLOCK** si Stitch produjo decisiones de diseno (colores, tipografia, spacing) que deben persistir. Solo si hay contenido real, no por defecto.

### Fase 3: Post-procesamiento

Ensamblar paste-ready para el Paso 4:
```bash
npm run discipline:assemble -- --step 4
```

Registrar en run-log:
```bash
npm run discipline:log -- --step 3 --tool "Stitch <MCP|manual> + Claude" --notes "Automated via /discipline-step3"
```

### Fase 4: Resumen y siguiente paso

```
Paso 3 completado.

Herramienta: Stitch <MCP | manual>
Pantallas documentadas: <N>
<lista de nombres de pantalla>

Archivos generados:
- .discipline/packets/UI_HANDOFF_PACKET.md
<si se genero:>
- .discipline/packets/DESIGN_MD_READY_BLOCK.md

Paste-readies actualizados:
- .discipline/paste-ready/paso-4-input.md

Siguiente paso: /discipline-step4 (Slices ejecutables)
```

---

## Manejo de errores

- Si LANE es BACKEND o CLI: detenerse inmediatamente. No es un error, es un skip esperado.
- Si STEP_3_STITCH_PACKET no existe: detenerse con "Ejecuta /discipline-step1 primero."
- Si Stitch MCP falla: caer al modo guiado (Fase 1B). Reportar el error del MCP.
- Si Stitch no puede generar alguna pantalla: documentar en UI_HANDOFF_PACKET con "TODO: requiere generacion manual" y registrar en findings.md.
- Si el operador reporta que Stitch no cubrio un flujo: documentar como gap e incluir en el handoff para que el Paso 5 lo resuelva durante implementacion.
- Si `npm run discipline:assemble` falla: reportar. El UI_HANDOFF_PACKET ya esta en `.discipline/packets/`.
- Si `npm run discipline:log` falla: reportar pero no bloquear.

---

## Reglas criticas

- **Stitch es la herramienta primaria.** No generar pantallas con Claude. Claude ensambla el packet a partir de lo que Stitch produjo.
- Si Stitch MCP esta disponible, usarlo. Si no, guiar al operador. En ambos casos, Stitch genera las pantallas.
- Los 4 estados (normal, loading, empty, error) son obligatorios por pantalla. Si Stitch no los genero todos, completar la documentacion de estados a partir de la pantalla normal y los contratos del proyecto.
- Las adaptaciones por LANE son obligatorias. Una pantalla WEB debe incluir responsive notes; una MOBILE debe incluir safe areas.
- No inventar pantallas que no esten en el STITCH_PACKET. Solo documentar las P0 listadas.
- No recomendar librerias de componentes a menos que discipline.md o el STITCH_PACKET las mencione.
- Las notas de implementacion son hints, no codigo. El codigo se escribe en el Paso 5.
- Si hay inconsistencias entre Stitch y el STEP_4_EXECUTION_PACKET (ej: pantalla referencia datos que no estan en contratos), documentar en findings.md y usar los contratos como fuente de verdad.
