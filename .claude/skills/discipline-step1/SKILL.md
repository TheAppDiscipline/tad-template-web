---
name: discipline-step1
description: "Automate Discipline Loop Step 1: generate PRD, contracts, switches, and handoff packets from an app description. Triggers on /discipline-step1 or 'run step 1' / 'ejecutar paso 1'."
---

# /discipline-step1 - Automatizar Paso 1 del pipeline Discipline Loop

Este skill ejecuta el Paso 1 completo: configura el proyecto, genera los 13 outputs (PRD, user stories, data model, validación cruzada, packets de handoff), y deja todo listo para el Paso 2.

No requiere herramientas externas. Claude genera todo directamente.

## Lo que el usuario ve

1. El skill pide que describa su app (si no hay descripción previa)
2. Hace hasta 3 preguntas de clarificación si la descripción tiene vacíos
3. Infiere la configuración técnica, la muestra, y pide confirmación
4. Genera 3 archivos de input pre-llenados para que el usuario los revise
5. Una vez confirmados, genera los 13 outputs secuencialmente
6. Si la validación cruzada (Output 8) detecta inconsistencias, las corrige antes de generar los packets finales
7. Reporta progreso (`✓ Output N/13: nombre`) y al final muestra un resumen

## Prerrequisitos

- Node.js + npm (para correr los scripts de Discipline Loop)
- El proyecto debe estar basado en el Repo Template (o tener `package.json` con los scripts `discipline:*`)

No se necesita Playwright ni cuentas externas.

---

## Implementación interna

### Fase 0: Verificar o configurar proyecto

Verificar si existe `discipline.md` en el directorio actual y si tiene los switches configurados. Leer `discipline.md` y revisar si los campos clave tienen valores (PROFILE, BACKEND_PROVIDER, AUTH_MODE). Si están vacíos o son placeholder (e.g., `PROFILE:` sin valor), los switches NO están configurados.

**Si los switches YA están configurados:** continuar a Fase 1.

**Si NO existe `discipline.md` O los switches están vacíos:**

Pedirle al usuario que describa su app en lenguaje natural:

```
Descríbeme tu app: ¿qué hace, para quién es, y qué necesita el usuario poder hacer?

Ejemplo: "Una app web para que equipos pequeños trackeen sus tareas semanales. 
Cada miembro crea su cuenta con Google, ve sus tareas y las del equipo, 
y el líder puede asignar tareas a otros."
```

Si ya existe un `IDEA_VALIDATION_PACKET` en `.discipline/packets/` o una descripción en `00_Input_Bruto.md`, usar esa información en vez de preguntar.

**Analizar la descripción y detectar vacíos críticos.** Antes de inferir switches, revisar si la descripción cubre estos 4 ejes:

1. **Problema**: ¿Queda claro qué dolor resuelve? Si no, preguntar.
2. **Usuarios**: ¿Queda claro quién la usa y si hay roles distintos? Si no, preguntar.
3. **Acciones clave**: ¿Queda claro qué puede hacer cada usuario? Si no, preguntar.
4. **Datos**: ¿Queda claro qué información se guarda y si se comparte? Si no, preguntar.

Si faltan 1 o más ejes, hacer las preguntas de clarificación **en un solo mensaje** (no una por una). Ejemplo:

```
Antes de configurar el proyecto necesito aclarar un par de cosas:

1. ¿Cada persona crea sus propias tareas o alguien las asigna?
2. ¿Las tareas tienen fecha límite o solo se marcan como completadas?

Con eso tengo lo que necesito para continuar.
```

Reglas para las preguntas de clarificación:
- Máximo 3 preguntas. Si hay más de 3 vacíos, priorizar los que afectan switches (roles→COLLAB, datos compartidos→BACKEND, login→AUTH).
- Solo preguntar lo que no se puede asumir razonablemente. Si la respuesta obvia es "sí" o "no", asumir y seguir.
- No preguntar sobre tecnología (backend, hosting, auth method). Eso se infiere.

Una vez que la descripción tiene los 4 ejes cubiertos, continuar:

**Inferir switches de la descripción.** Analizar lo que el usuario dijo y deducir la configuración técnica:

| Señal en la descripción | Switch | Valor inferido |
|---|---|---|
| "app web", "se abre en el navegador", "PWA", o no menciona plataforma | LANE | WEB |
| "app móvil", "iPhone", "Android", "App Store" | LANE | MOBILE |
| "extensión de Chrome/Firefox" | LANE | EXTENSION |
| "API", "backend", "servicio" | LANE | BACKEND |
| Pocas funciones, un tipo de usuario, uso personal | PROFILE | LITE |
| Varios tipos de datos, compartir con familia/grupo cerrado | PROFILE | FAMILY_SYNC |
| Beta público / primeros pagantes, sin scorecard PROD completo | PROFILE | LAUNCH |
| Roles, permisos, admin, múltiples flujos, comercial ≥50 activos | PROFILE | PROD |
| "login", "crear cuenta", "usuarios", "equipo", "miembros" | AUTH | MAGIC_LINK (default si no especifica método) |
| "Google login", "entrar con Google" | AUTH | GOOGLE |
| "sin login", "sin cuenta", uso personal sin mencionar cuentas | AUTH | NONE |
| Si AUTH=NONE y no menciona compartir ni sync entre dispositivos | BACKEND | LOCAL_ONLY |
| Si necesita cuentas, datos compartidos, o sync | BACKEND | SUPABASE (default) |
| Menciona "Firebase" o "Google Cloud" explícitamente | BACKEND | FIREBASE |
| "compartir", "equipo", "colaborar", "asignar a otros" | COLLAB | COLLABORATIVE |
| "ver lo de otros", "compartir (lectura)", o no menciona colaboración | COLLAB | VIEW_ONLY |
| "IA", "generar texto", "analizar con AI", "chatbot" | AI_FEATURES | enabled |
| No menciona IA | AI_FEATURES | none |
| "notificaciones", "alertas", "recordatorios push" | PUSH | true |
| No menciona notificaciones | PUSH | false |

Inferencias automáticas (no se preguntan):
- SYNC: Si BACKEND=LOCAL_ONLY→OFFLINE_FIRST, cualquier otro→FAST_UI
- HOSTING: Vercel (default)

**Mostrar la configuración inferida y pedir confirmación:**

```
Basándome en tu descripción, esta es la configuración que recomiendo:

- Tipo: Web (LANE=WEB)
- Complejidad: Media, varios usuarios, datos compartidos (PROFILE=FAMILY_SYNC)
- Login: Con Google (AUTH=GOOGLE)
- Base de datos: Supabase, rápido de configurar, buen tier gratis (BACKEND=SUPABASE)
- Colaboración: Los usuarios pueden editar datos compartidos (COLLAB=COLLABORATIVE)
- Sincronización: UI rápida con sync al backend (SYNC=FAST_UI)
- IA: No (AI_FEATURES=none)
- Notificaciones push: No (PUSH=false)
- Hosting: Vercel (HOSTING=Vercel)

¿Está bien así o quieres cambiar algo?
```

El usuario puede decir "sí", "perfecto", o "cambia X por Y". Ajustar según feedback.

Una vez confirmado, ejecutar. Usar `--force` si `discipline.md` ya existe (para sobrescribir los switches vacíos):

```bash
npm run discipline:hydrate -- --lane <LANE> --profile <PROFILE> --backend <BACKEND> --auth <AUTH> --collab <COLLAB> --sync <SYNC> --ai <AI> --push <PUSH> --hosting <HOSTING> --force
```

**Después de hydrate, llenar los campos de identidad en `discipline.md`.** Extraer de la descripción del usuario:
- `PROJECT_NAME`: nombre corto de la app (ej: "MyWeek", "TaskFlow", "FamilyBudget"). Si el usuario no dio nombre, inferir uno descriptivo del propósito.
- `PRIMARY_GOAL`: una frase que resuma el objetivo principal (ej: "Ayudar a equipos pequeños a organizar tareas semanales")
- `NORTH_STAR_METRIC`: métrica medible (ej: "% de tareas completadas por semana", "usuarios activos semanales")

Editar `discipline.md` directamente para reemplazar los placeholders `<APP_NAME>`, `<one sentence>`, `<measurable metric>` con los valores reales.

### Fase 1: Preparar inputs

**Guardar la descripción del usuario como IDEA_VALIDATION_PACKET.** Si el usuario dio su descripción en Fase 0, guardarla en `.discipline/packets/IDEA_VALIDATION_PACKET.md` con este formato:

```markdown
# IDEA_VALIDATION_PACKET

## Problema
<extraer de la descripción del usuario: qué problema resuelve>

## Usuario objetivo
<extraer de la descripción: para quién es>

## Diferenciador
<extraer de la descripción: qué lo hace diferente, o "A definir en Paso 1" si no lo mencionó>

## Descripción original
<la descripción textual que dio el usuario>
```

```bash
npm run discipline:step1-prep
```

Genera:
- `.discipline/step1-input/00_Input_Bruto.md` - pre-llenado con `IDEA_VALIDATION_PACKET`
- `.discipline/step1-input/01_Ejemplos_Reales.md` - template con formato de casos
- `.discipline/step1-input/02_Restricciones.md` - pre-llenado con switches de `discipline.md`
- `.discipline/prompts/paso-1-all-prompts.md` - los 13 prompts interpolados con switches del proyecto

**Después de que `step1-prep` genere los archivos, enriquecer `01_Ejemplos_Reales.md` con un borrador de casos de uso.** Analizar la descripción del usuario y generar 3-5 casos de uso concretos con este formato:

```markdown
## Caso: <nombre descriptivo>
- Actor: <quién>
- Acción: <qué hace paso a paso>
- Resultado esperado: <qué ve/obtiene>
- Dato clave: <qué dato se crea, lee, o modifica>
```

Escribir el borrador directamente en `.discipline/step1-input/01_Ejemplos_Reales.md`.

**Abrir los 3 archivos de input para que el usuario los revise.** Mostrar un resumen de qué hay en cada uno:

```
Los 3 archivos de input están listos para revisión:

1. 00_Input_Bruto.md - Tu idea de app (pre-llenado con lo que me describiste)
2. 01_Ejemplos_Reales.md - Casos de uso que generé basándome en tu descripción (revisa que tengan sentido)
3. 02_Restricciones.md - La configuración técnica que confirmaste

Revísalos y dime si quieres cambiar algo, o "listo" para continuar.
```

No continuar hasta que el usuario confirme. Si el usuario quiere cambiar algo, aplicar los cambios y volver a mostrar el resumen.

### Fase 2: Generar los 13 outputs

Leer los prompts de `.discipline/prompts/paso-1-all-prompts.md`. Leer los 3 archivos de input como contexto. Leer el system prompt de la sección "SYSTEM PROMPT" del archivo de prompts.

**Contexto para la generación:** Antes de generar cada output, Claude debe tener en mente:
- El system prompt (actuar como Product Manager + Systems Designer)
- Los 3 archivos de input (idea, ejemplos, restricciones)
- Todos los outputs generados hasta el momento (cada output puede referenciar los anteriores)

**Ejecutar outputs 1-7, luego Output 8 (validación), resolver problemas, y finalmente outputs 9-13.**

**Para cada output (1-7):**

1. **Verificar si aplica.** El archivo de prompts marca los condicionales con "(SKIP)". Si dice SKIP, saltarlo.

2. **Verificar si ya existe.** Si el archivo de destino ya existe (de una ejecución anterior parcial), preguntar si re-generar o saltar.

3. **Generar el output.** Usar el prompt correspondiente del archivo de prompts. Aplicar el system prompt como contexto. Incluir los 3 archivos de input y todos los outputs anteriores como referencia.

4. **Guardar en** `.discipline/step1-outputs/<note_title>.md`

5. **Reportar:** `✓ Output N/13: <nombre>`

**Output 8 - Validación cruzada (tratamiento especial):**

**Importante: usar Extended Thinking para este output.** La cross-validation es un quality gate critico. Incluir "think deeply about inconsistencies" para activar razonamiento profundo. El valor de este output es detectar errores que la generacion de outputs 1-7 introdujo sin darse cuenta.

Generar el Output 8 usando el prompt de validación. Este prompt le pide revisar todos los outputs 1-7 buscando inconsistencias.

Guardar en `.discipline/step1-outputs/10_Validation.md`. Luego analizar el contenido:

- **Si NO hay inconsistencias**: reportar `✓ Output 8/13: Validación - sin inconsistencias` y continuar a outputs 9-13.

- **Si HAY inconsistencias (sin importar si parecen menores o graves)**:
  **OBLIGATORIO: corregir TODAS las inconsistencias ANTES de continuar a outputs 9-13.** No posponer correcciones para después. No juzgar si son "menores". Los packets 9-13 se construyen sobre los outputs 1-7; si hay errores, se propagan.
  1. Reportar: `⚠ Output 8: N inconsistencias detectadas. Corrigiendo antes de generar packets...`
  2. Para cada output afectado (1-7), regenerar el output completo aplicando las correcciones indicadas por la validación.
  3. Sobrescribir el archivo en `.discipline/step1-outputs/` con la versión corregida.
  4. Reportar: `✓ Output N corregido: <nombre>`
  5. **NO continuar a outputs 9-13 hasta que todas las correcciones estén aplicadas.**

**Para cada output (9-13), después de resolver validación:**

Misma lógica que 1-7, pero guardar en ubicaciones diferentes:
   - Outputs 9-13: guardar en `.discipline/packets/<packet_file>.md`
   - Output 12: agregar `STATUS: borrador` al inicio del archivo
   - Output 13: separar en `DISCIPLINE_MD_READY_BLOCK.md` + `TASK_PLAN_READY_BLOCK.md`

**Referencia de outputs y destinos:**

| Output | Nota | Archivo | Destino |
|---|---|---|---|
| 1 | PRD | `03_PRD.md` | `.discipline/step1-outputs/` |
| 2 | User Stories | `04_User_Stories.md` | `.discipline/step1-outputs/` |
| 3 | Data Model | `05_Data_Model.md` | `.discipline/step1-outputs/` |
| 4 | UI States | `06_UI_States.md` | `.discipline/step1-outputs/` |
| 5 | Events | `07_Events_and_Notifications.md` | `.discipline/step1-outputs/` |
| 6 | Architecture Switches | `08_Architecture_Switches.md` | `.discipline/step1-outputs/` |
| 7 | Export for Discipline Loop | `09_Export_for_DisciplineLoop.md` | `.discipline/step1-outputs/` |
| 8 | Validation | `10_Validation.md` | `.discipline/step1-outputs/` |
| 9 | STEP_2_ARCHITECTURE_PACKET | `STEP_2_ARCHITECTURE_PACKET.md` | `.discipline/packets/` |
| 10 | STEP_2_5_AI_PACKET | `STEP_2_5_AI_PACKET.md` | `.discipline/packets/` (solo si AI_FEATURES=enabled) |
| 11 | STEP_3_STITCH_PACKET | `STEP_3_STITCH_PACKET.md` | `.discipline/packets/` (solo si LANE no es BACKEND ni CLI) |
| 12 | STEP_4_EXECUTION_PACKET | `STEP_4_EXECUTION_PACKET.borrador.md` | `.discipline/packets/` (con STATUS: borrador) |
| 13 | REPO_READY_BLOCKS | `DISCIPLINE_MD_READY_BLOCK.md` + `TASK_PLAN_READY_BLOCK.md` | `.discipline/packets/` |

### Fase 3: Post-procesamiento

```bash
npm run discipline:assemble -- --step 2
```

Si AI_FEATURES=enabled:
```bash
npm run discipline:assemble -- --step 2.5
```

Si LANE no es BACKEND ni CLI:
```bash
npm run discipline:assemble -- --step 3
```

Aplicar ready blocks al repo:
- `DISCIPLINE_MD_READY_BLOCK.md` → `discipline.md`
- `TASK_PLAN_READY_BLOCK.md` → `task_plan.md`

Registrar en run-log:
```bash
npm run discipline:log -- --step 1 --tool "Claude" --notes "Automated via /discipline-step1"
```

### Fase 4: Resumen y validación final

Mostrar al usuario:
- Cuántos outputs se generaron (de los 13 posibles)
- Qué packets están listos en `.discipline/packets/`
- Qué paste-readies se ensamblaron
- Cuál es el siguiente paso (Paso 2: Arquitectura)

**Cross-validation final (automática, no preguntar).** Leer todos los packets generados y los outputs de referencia. Buscar inconsistencias entre ellos: datos contradictorios, user stories que no cuadran con el PRD, contratos que no cubren los flujos descritos, switches que no se reflejan en los packets.

- Si encuentra inconsistencias: reportar cada una, corregir los archivos afectados directamente, y reportar las correcciones.
- Si no encuentra inconsistencias: confirmar que todo es coherente.

---

## Manejo de errores

- Si `npm run discipline:step1-prep` falla: verificar que `package.json` tiene el script y que las dependencias están instaladas (`npm install`). Si `tsx` no se encuentra, usar `npx tsx`.
- Si `npm run discipline:assemble` falla: verificar que los packets existen en `.discipline/packets/`.
- Si un output falla al generarse: guardar cuál falló y continuar con el siguiente. Al final, reportar los outputs faltantes para que el usuario pueda re-ejecutar `/discipline-step1` (los outputs ya completados no se re-generan).
