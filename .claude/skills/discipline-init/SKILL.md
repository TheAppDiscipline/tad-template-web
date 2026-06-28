---
name: discipline-init
description: "One-shot bootstrap for a new Discipline Loop project. Clones the lane template, runs npm install, verifies dependencies, initializes discipline.md with a chosen profile, and produces the first paste-ready. Triggers on /discipline-init <lane>, 'init project', 'crear proyecto'."
---

# /discipline-init - Bootstrap one-shot de un proyecto Discipline Loop

Este skill es el "Día 0": clona el repo template del lane elegido, instala dependencias, verifica que todo arranca, y deja al usuario listo para correr `/discipline-step0a` (validar idea) o `/discipline-step1` (PRD) según donde esté en el pipeline.

NOTA: el skill no decide el lane por el usuario. Si dudas qué lane usar, primero corre `/discipline-step0a` (que produce IDEA_VALIDATION_PACKET) y/o consulta la guía de elección de lane del vault. Después invoca este skill con el lane confirmado.

## Lo que el usuario ve

1. El skill confirma el lane (`web` / `mobile` / `desktop` / `extension`).
2. Pregunta nombre del proyecto y profile inicial (default `FAMILY_SYNC` por NN #6).
3. Clona el template oficial desde GitHub al directorio elegido.
4. Corre `npm install` y verifica que no hay errores de instalación.
5. Verifica versión Node ≥ 20, Git ≥ 2.40 (según la guía de Setup para No Programadores del vault).
6. Inicializa `discipline.md §0` con switches según el profile elegido (vía `discipline:hydrate` si el script existe).
7. Ofrece correr `npm run dev` para verificar arranque.
8. Sugiere siguiente comando: `/discipline-step0a` (si idea no validada) o `/discipline-step1` (si ya validada).

## Prerrequisitos

- Node.js >= 20 instalado (verificar con `node --version`).
- Git instalado (verificar con `git --version`).
- Conexión a internet (necesaria para clonar template).
- Para `mobile` lane: opcional `npm install -g eas-cli` para deploys posteriores.
- Para `desktop` lane: opcional Rust toolchain instalado (Tauri necesita `cargo` para builds nativos).

---

## Implementacion interna

### Fase 0: Verificar prerequisitos

Correr y capturar:
```bash
node --version    # debe ser >= 20
git --version     # debe ser >= 2.40
npm --version     # debería existir junto con node
```

Si node < 20 o git ausente:
```
Prerequisitos faltantes:
- <lista>

Antes de continuar, instala lo que falta:
1. Node.js >= 20: https://nodejs.org/en/download
2. Git: https://git-scm.com/downloads

Si eres no-programador, ver las instrucciones paso a paso de Setup para No Programadores en el vault.
```

Detener si falta algo.

### Fase 1: Recoger inputs

Pedir al usuario:
- **Lane** (web / mobile / desktop / extension). Si no se pasó como argumento, preguntar.
- **Nombre del proyecto** (slug-friendly, ej: `mi-app`).
- **Directorio destino** (default: directorio actual + nombre de proyecto).
- **Profile inicial** (default FAMILY_SYNC; opciones: LITE, FAMILY_SYNC, LAUNCH, PROD). Si LITE, ofrecer también `BACKEND_PROVIDER=LOCAL_ONLY`.

Validar:
- Lane es uno de los 4 oficiales.
- Nombre slug-friendly (regex `/^[a-z0-9-]+$/`).
- Directorio destino no existe o está vacío.

### Fase 2: Mapear lane a template URL

| Lane | URL del template | Nota |
|---|---|---|
| `web` | `https://github.com/TheAppDiscipline/tad-template-web.git` | React + Vite + TS, default si dudas |
| `mobile` | `https://github.com/TheAppDiscipline/tad-template-mobile.git` | Expo + React Native + TS |
| `desktop` | `https://github.com/TheAppDiscipline/tad-template-desktop.git` | Tauri v2 + React + Vite |
| `extension` | `https://github.com/TheAppDiscipline/tad-template-extension.git` | WXT + React + TS, MV3 |

### Fase 3: Clonar template

```bash
git clone --depth 1 <template-url> <project-dir>
cd <project-dir>
rm -rf .git    # quitar historia del template
git init
git add .
git commit -m "Initial commit from tad-template-<lane>"
```

Si falla el clone (network, repo private):
- Para repos privados, sugerir `gh auth login` o `git config --global credential.helper`.
- Para problemas de network, sugerir `git clone https://...` con `--config http.proxy=` si aplica.

### Fase 4: Instalar dependencias

```bash
cd <project-dir>
npm install
```

Capturar warnings y errores. Si npm install falla:
- Limpiar cache: `npm cache clean --force` y reintentar.
- Si persiste, mostrar error y referir al usuario a la sección de Errores Comunes del Gate (Windows / entorno local) del vault o el equivalente del SO.

Verificar que `tools/discipline/` existe y `package.json` tiene scripts `discipline:*`. Si no, el clone falló o el template está corrupto.

### Fase 5: Inicializar discipline.md con profile

Correr:
```bash
npm run discipline:hydrate
```

Si el script existe (todos los templates oficiales lo tienen post-Wave 3.1), genera `discipline.md` con switches default. Después aplicar patch para ajustar profile si es distinto del default:

```bash
# Solo si profile != FAMILY_SYNC (default del template)
echo "<patch block to set PROFILE=<profile>>" > .discipline/patches/pending/init-profile.md
npm run discipline:patch
```

Si `discipline:hydrate` no existe (template antiguo), crear `discipline.md` minimal manualmente con switches:

```markdown
# discipline.md

## 0) Profile

LANE=<lane>
PROFILE=<profile>
BACKEND_PROVIDER=<supabase|firebase|local_only>
AUTH_MODE=<magic_link|none>
COLLAB_MODE=<collaborative|single_user>
SYNC_MODE=<fast_ui|server_authoritative|none>
AI_FEATURES=<enabled|none>
```

### Fase 6: Verificar arranque (opcional)

Ofrecer al usuario:
```
¿Quieres verificar que arranca? Esto corre `npm run dev` durante 10 segundos para confirmar que el bundler genera la app sin errores. (Y/N)
```

Si Y, ejecutar `npm run dev &` en background, esperar 10s, verificar:
- Web/Desktop: HTTP 200 en localhost:5173 o equivalente.
- Mobile: Expo CLI imprime QR sin errores.
- Extension: WXT imprime "ready" sin errores.

Detener el dev server. Reportar resultado.

### Fase 7: Resumen y siguiente paso

```
Proyecto Discipline Loop inicializado en <directorio>.

Lane: <lane>
Profile: <profile>
Switches: <BACKEND, AUTH, SYNC, AI>

Estructura creada:
- .discipline/ (packets, patches, paste-ready)
- .claude/ (skills bundled, settings)
- discipline.md, task_plan.md, findings.md, progress.md
- tools/, src/, tests/

Verificación:
- ✓ Node <version>
- ✓ Git <version>
- ✓ npm install completo (<N> paquetes)
- ✓ tools/discipline/ presente
<si verificación de arranque corrió:>
- ✓ npm run dev arranca sin errores

Siguiente paso recomendado:
<si IDEA_VALIDATION_PACKET no existe:>
1. Validar la idea: `/discipline-step0a` (10-30 min, usa WebSearch real)
2. Si GO, generar PRD: `/discipline-step1` (30-60 min)

<si ya tienes idea validada:>
1. Generar PRD: `/discipline-step1` con tu idea como input.

Para diagnostico del proyecto en cualquier momento: `/discipline-doctor`.
Catalogo completo de skills: ver la Biblioteca de Skills Discipline Loop en el vault.

Bienvenido a Discipline Loop.
```

### Fase 8: Logging

Registrar en `findings.md §Audits`:
```markdown
- <fecha> · /discipline-init · lane=<lane> · profile=<profile> · template=<url> · node=<version>
```

---

## Manejo de errores

- `git clone` falla: ver Fase 3.
- `npm install` falla: ver Fase 4.
- Directorio destino ya existe y no está vacío: preguntar si sobreescribir, abortar, o cambiar nombre.
- Network sin internet: detectar via `ping github.com` o equivalente; advertir usuario.
- Profile invalido: rechazar y mostrar opciones validas.
- Lane invalido: rechazar y mostrar los 4 lanes oficiales con descripcion corta.

---

## Reglas criticas

- No sobreescribir un repo existente sin confirmación explícita.
- No commitear automáticamente más allá del initial commit.
- No instalar deps opcionales (eas-cli, Rust) a menos que el usuario lo pida explícitamente.
- No saltar verificación de Node/Git versions; saltarla genera errores misteriosos en pasos posteriores.
- No asumir que el usuario quiere clonar el último main; ofrecer `--ref` o `--tag` para reproducibilidad si el usuario lo necesita.
- Tiempo objetivo: 5-15 min total (3-5 clone + install + 30s hydrate + 10s verificación).
- Para no-programadores, este skill puede ser su PRIMERA invocación. Sé extra explicativo en errores y siguientes pasos.
