---
name: discipline-overengineering-check
description: "Detect over-engineering and under-engineering signals against the Anti-overengineering Doctrine in the vault. Reads discipline.md + package.json + progress.md + git log; flags deps per slice ratio, premature abstractions, skipped gates, or sub-engineering (RLS off, secrets in client). Triggers on /discipline-overengineering-check, 'check overengineering', 'auditar complejidad'."
---

# /discipline-overengineering-check - Detectar over/under engineering en el proyecto

Este skill auto-aplica las 10 reglas de la Anti-overengineering Doctrine del vault contra el estado actual del proyecto. Reporta señales con confidence (clear violation / probable / possible) y sugiere acción concreta.

NOTA: el skill es advisory, no bloqueante. Las decisiones de scope siguen siendo del usuario; el skill solo señala cuando los patrones huelen a over o under engineering.

## Lo que el usuario ve

1. El skill lee 4 fuentes: `discipline.md`, `package.json`, `progress.md`, `git log` últimos 30 días.
2. Aplica los 10 chequeos de la doctrina (5 de over, 5 de under).
3. Reporta tabla por chequeo con: signal (clear / probable / possible), evidencia, regla violada, acción sugerida.
4. Resume al final: cuántos clear, cuántos probable, top 3 acciones por impacto.
5. Registra en `findings.md §Audits` como `audit-overengineering`.

## Prerrequisitos

- Repo con `.discipline/`, `discipline.md`, `progress.md`, `task_plan.md`.
- Git inicializado (necesario para evaluar deps por slice ratio y patrones de commits).
- `package.json` legible.

---

## Implementacion interna

### Fase 0: Recoger contexto

Leer:
- `discipline.md §0` para PROFILE, LANE, AI_FEATURES, SYNC_MODE, COLLAB_MODE.
- `package.json` para `dependencies` + `devDependencies` count.
- `progress.md` para slices declarados done (count de `## Slice` con outcome=done o `[x]`).
- `task_plan.md §Ready Slices` o equivalente.
- `git log --since="30 days ago" --oneline` (count + sample).
- `git log --since="30 days ago" --name-only` para detectar carpetas/archivos creados.
- `findings.md §Tech Debt` si existe.

Capturar para uso en chequeos:
- N_DEPS = count de runtime dependencies
- N_DEV_DEPS = count de devDependencies
- N_SLICES_DONE
- N_COMMITS_30D
- N_NEW_FOLDERS_SRC = nuevas carpetas en src/ últimos 30 días (heuristica de abstracciones)
- PROFILE
- DAYS_SINCE_INIT = días desde primer commit

### Fase 1: Chequeos de OVER engineering (5 reglas)

Cada chequeo devuelve: `clear` (alta confianza), `probable` (40-70% confidence), `possible` (alerta débil), o `none`.

#### Check OE-1: Demasiadas deps para el profile

**Regla 11c §1, §3:** complejidad justificada por dolor real. Profile LITE no debería pasar de ~10 deps; FAMILY_SYNC ~20; LAUNCH/PROD pueden subir.

**Logica:**
- LITE + N_DEPS > 10 → `probable`
- LITE + N_DEPS > 15 → `clear`
- FAMILY_SYNC + N_DEPS > 25 → `probable`
- FAMILY_SYNC + N_DEPS > 35 → `clear`
- LAUNCH/PROD: warning solo si crecimiento > 5 deps en últimos 30 días sin slices nuevos.

**Acción:** revisar deps con `npm ls --depth=0`; pregunta NN #16 Scope Guard, ¿esta dep tiene 1-5 líneas de implementación equivalente y dolor observado?

#### Check OE-2: Deps por slice ratio (deps/slice)

**Regla 11c §3:** dependency hostil al budget.

**Logica:**
- Si N_DEPS / max(N_SLICES_DONE, 1) > 5 → `probable`
- Si N_DEPS / max(N_SLICES_DONE, 1) > 8 y profile LITE/FAMILY_SYNC → `clear`

**Acción:** lista de deps NO importadas en src/ activamente (orphans); proponer remoción.

#### Check OE-3: Abstracciones prematuras

**Regla 11c §4:** regla de tres, no abstraigas con 2 instancias.

**Logica:**
- Detectar carpetas en src/ con nombre `helpers/`, `utils/`, `lib/`, `core/`, `abstract/`, `interfaces/` con < 2 archivos cada una → `possible`
- Detectar carpeta `models/` o `types/` con archivos >300 lineas y solo 1 consumidor en src/ (grep cross-import) → `probable`
- Carpeta `services/` con 1 servicio que tiene 1 método y 1 caller → `clear`

**Acción:** sugerir inlinar el código de la abstracción en el caller único hasta que aparezca segundo caller.

#### Check OE-4: Gate skipping signal

**Regla 11c §6, §7:** gate correcto para la fase.

**Logica:**
- Buscar en git log últimos 30 días commits con mensajes que contengan `skip gate`, `--no-verify`, `bypass gate`, `WIP`, `quick fix without test`, `temporary` → cada hit es `possible`.
- Buscar en `findings.md §Tech Debt` items que mencionen "skipped gate" → `probable`.
- Si N_COMMITS_30D > 50 y N_TESTS estática (no creció) → `probable` (commits sin tests).

**Acción:** correr `npm run gate:strict` en el commit actual; revisar deuda técnica documentada.

#### Check OE-5: Pipeline overhead vs scope

**Regla 11c §2, §8:** scope del profile + packets mínimos viables.

**Logica:**
- LITE + cada slice produciendo todos los 19 packets posibles → `clear` (overkill).
- LITE + `.discipline/scorecard.yaml` con >50 entries → `probable`.
- FAMILY_SYNC + sin Sentry preinstalado y > 5 slices done → `possible` (under-overhead, mira OE5 inverso en sub-eng).

**Acción:** podar packets a los 7 mínimos para LITE; deferrar scorecard YAML hasta LAUNCH.

### Fase 2: Chequeos de UNDER engineering (5 reglas)

Equivalente al opuesto, NN-related. Las reglas vienen de 11c §"Señales de sub-ingeniería".

#### Check UE-1: RLS desactivado en tablas con PII

**Logica:**
- Si BACKEND_PROVIDER=SUPABASE: leer migrations, detectar `CREATE TABLE` sin posterior `ENABLE ROW LEVEL SECURITY` o sin policies.
- Si la tabla tiene columnas que parecen PII (`email`, `name`, `phone`, `address`, `dob`) → `clear` cuando RLS off.

**Acción:** correr `/discipline-audit rls` (audit 2 de 48c) para reporte detallado y fixes.

#### Check UE-2: Secrets en cliente

**Logica:**
- Grep en `src/**/*.{ts,tsx,js}` por patrones `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `OPENAI_API_KEY` (sin `process.env` wrapping) → `clear`.
- Detectar imports de `@supabase/supabase-js` con literal de API key → `clear`.

**Acción:** rotar secret inmediatamente; correr `/discipline-audit secrets` (audit 8) para gitleaks scan + remediation plan.

#### Check UE-3: catch {} vacíos

**Logica:**
- ESLint rule `no-empty` ya catches esto (NN #18). Verificar si está activa en eslint.config.js.
- Si la regla está disabled o set a `warn`, marcar `probable`.

**Acción:** activar `'no-empty': ['error', { allowEmptyCatch: false }]` en eslint config y correr lint.

#### Check UE-4: Queries sin LIMIT

**Logica:**
- Grep `.from('<tabla>').select` sin `.limit(...)` → `probable` (cada hit).
- `npm run check-queries` ya detecta esto post-Wave 3.1.

**Acción:** correr `npm run check-queries` o `/discipline-audit query-discipline` (audit 11).

#### Check UE-5: Sin Sentry/observabilidad en app pública

**Logica:**
- PROFILE >= LAUNCH y `package.json` sin `@sentry/*` ni `posthog-js` → `clear`.
- PROFILE = FAMILY_SYNC y app desplegada (detectar via `discipline:status` o git tags como `v0.x`) y sin observabilidad → `probable`.

**Acción:** instalar Sentry mínimo para Gate D; ver el vault (60 - Seguridad Esencial, Observability baseline) o equivalente.

### Fase 3: Reportar

Tabla agregada:

```markdown
## Discipline Loop · Overengineering / Underengineering Check

**Generado:** <fecha>
**Profile:** <profile>
**Estado:** <N clears> · <N probables> · <N possibles>

### Over engineering

| Check | Signal | Evidencia | Regla violada | Acción |
|---|---|---|---|---|
| OE-1 deps por profile | clear | 18 deps en LITE (límite ~10) | NN #16 Scope Guard, 11c §1 | Revisar `npm ls --depth=0`; podar deps no esenciales |
| OE-2 deps/slice ratio | probable | 6.0 (limite 5.0) | 11c §3 | Listar deps orphan |
| ... | ... | ... | ... | ... |

### Under engineering

| Check | Signal | Evidencia | Regla violada | Acción |
|---|---|---|---|---|
| UE-1 RLS | none | Todas las tablas con PII tienen RLS + policies | NN #17.3 | OK |
| ... | ... | ... | ... | ... |

### Top 3 acciones por impacto

1. <accion mas crítica entre los clear>
2. ...
3. ...

### Veredicto general

<En balance | Sobre-ingeniado | Sub-ingeniado | Mixto>
```

### Fase 4: Registrar en findings.md

```markdown
## Audits

- <fecha> · audit-overengineering · clears=<N> · probables=<N> · top-action=<accion>
```

Si hay `clear` UE-1 (RLS off con PII) o UE-2 (secrets en cliente), también agregar a `findings.md §Risks`:
```markdown
- <fecha> · CRITICAL · audit-overengineering UE-2 detecta API key hardcoded en src/<archivo> · rotar inmediatamente.
```

### Fase 5: Resumen al usuario

```
Overengineering Check completado.

OVER engineering: <N clears> / <N probables> / <N possibles>
UNDER engineering: <N clears> / <N probables> / <N possibles>

Top 3 acciones:
1. ...
2. ...
3. ...

Veredicto: <En balance | Sobre-ingeniado | Sub-ingeniado | Mixto>

Detalle: findings.md §Audits.

Nota: este skill es advisory. El usuario decide si los signals justifican accion. Para signals `clear`, especialmente UE-1/UE-2, accion es practicamente obligatoria antes de Gate D.
```

---

## Manejo de errores

- Repo sin git: marcar OE-4 (gate skipping) como N/A, otros checks corren normalmente.
- progress.md vacío o ausente: aplicar checks asumiendo N_SLICES_DONE = 0; eso amplifica deps/slice ratio detection.
- discipline.md sin PROFILE: usar default FAMILY_SYNC para los thresholds.
- src/ vacío (template recién hidratado): la mayoría de checks devuelven `none`; reportar que el repo está en estado prematuro.

---

## Reglas críticas

- Los signals son advisory, no bloqueantes. No fail el gate ni bloquear merges.
- `clear` UE-1 y UE-2 (RLS off + secrets en cliente) son los más urgentes; priorizarlos en top-3.
- No sugerir REMOVER deps en bloque sin verificar imports; "orphan" es heurística (puede ser dep usada via require dinámico o config).
- No marcar abstracción como prematura sin verificar que solo hay 1-2 callers (regla de tres).
- Tiempo objetivo: <2 minutos para todo el reporte.
- Si el usuario invoca el skill mensualmente, registrar tendencia en findings.md (ej: "deps creciendo +5 desde último audit").
