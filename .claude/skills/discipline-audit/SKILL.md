---
name: discipline-audit
description: "Run one or all 15 self-audit prompts from 48c (Prompts de Auto-Auditoría) against the project. Each prompt validates specific NN against current state, produces structured JSON/Markdown output, and auto-logs entry to findings.md §Audits. Triggers on /discipline-audit <n|all|name>, 'auditar X', 'audit project'."
---

# /discipline-audit - Orquestar los 15 prompts de auto-auditoria de Discipline Loop

Este skill ejecuta uno o todos los 15 prompts de los Prompts de Auto-Auditoría del vault en sesion unica. Convierte 15 operaciones manuales copy/paste en un comando, captura outputs estructurados, y registra cada run en `findings.md §Audits`.

Uso recomendado: pre-Gate D Launch (correr `all`), pre-Gate E PROD (correr `all` con foco en P-categoria), retros mensuales de la Retrospectiva del Factory del vault.

## Lo que el usuario ve

1. El skill pide indice o nombre del audit (`1`-`15`, `all`, o slug como `rls`, `secrets`, `a11y`).
2. Para cada audit ejecutado:
   a. Lee inputs requeridos (archivos, comandos shell, output de tools).
   b. Aplica los criterios del prompt correspondiente.
   c. Produce output con schema declarado en 48c.
   d. Anota entry en `findings.md §Audits`.
3. Si modo `all`, al final reporta agregado: cuantos PASS, cuantos GAP, top 3 acciones por impacto.

## Prerrequisitos

- Repo con `.discipline/` y artefactos canonicos (`discipline.md`, `task_plan.md`, `findings.md`, `progress.md`).
- Comandos del template oficial disponibles segun el audit (`npm run gate`, `npx gitleaks`, `npx tsc`, `npx lighthouse`, etc.).
- WebSearch no requerido (todo es local).
- Credenciales activas si el audit las necesita (audits 3, 10, 15 referencian vendors externos).

---

## Catalogo de los 15 audits

Mapeo de indice a slug y NN validado. Cuando el usuario invoca el skill puede usar cualquiera de los tres.

| # | Slug | Valida | Frecuencia recomendada |
|---|---|---|---|
| 1 | `nn-coverage` | NN 1, 11, 12, 17 contra discipline.md | Pre-Gate C, post-Paso 2 |
| 2 | `rls` | NN 17.3 RLS contra migrations | Tras cada migration que toca PII |
| 3 | `privacy-policy` | NN 17 + 62 §Privacy contra app real | Pre-Gate D, al añadir vendor |
| 4 | `perf` | NN 20 (bundle + Lighthouse) | Pre-deploy, pre-Gate D |
| 5 | `progress-drift` | NN 5, 8 (progress.md vs git) | Inicio de sesion con retro |
| 6 | `findings-gaps` | NN 5 (memoria) | Fin de semana de dev |
| 7 | `test-coverage` | NN 22 (boundaries) | Pre-Gate C, pre-Gate D |
| 8 | `secrets` | NN 17.5 | Pre-push a main, repo heredado |
| 9 | `ts-strict` | NN 21 (any, ts-ignore) | Semanal, cuando tsc tarda |
| 10 | `deps-vulns` | NN 17.7 | Cada 2 semanas, pre-release |
| 11 | `query-discipline` | NN 23 (N+1, indices) | Tras cada slice con queries, pre-Gate D |
| 12 | `a11y` | NN 24 (WCAG AA) | Pre-Gate D |
| 13 | `error-handling` | NN 18 | Pre-Gate C |
| 14 | `tokens` | NN 9 (UI tokens) | Tras cada PR de UI |
| 15 | `backup-restore` | 62 + NN 17 operacional | Mensual, pre-Gate E |

---

## Implementacion interna

### Fase 0: Resolver invocacion

Input del usuario: numero `1`-`15`, `all`, slug de la tabla, o nombre parcial.

Resolver a la lista de audits a correr. Si ambiguo (eg `coverage` matches 7 y 14), pedir clarificacion.

### Fase 1: Verificar contexto

Antes de cada audit:
- Leer `discipline.md §0` para extraer PROFILE y switches (algunos audits aplican solo a ciertos profiles).
- Saltar audits no aplicables. Ejemplos:
  - audit 2 RLS: skip si BACKEND_PROVIDER != SUPABASE.
  - audit 3 privacy: skip si PROFILE = LITE sin externos.
  - audit 12 a11y: skip si lane sin UI (CLI/Backend, hoy archivados v1.0).
  - audit 15 backup-restore: skip si BACKEND_PROVIDER = LOCAL_ONLY.

Al saltar, registrar en findings con razon: `skipped: not_applicable (PROFILE=LITE)`.

### Fase 2: Ejecutar cada audit

Para cada audit en la lista, aplicar el prompt correspondiente de los Prompts de Auto-Auditoría del vault. La estructura tipo:

#### Audit 1, nn-coverage (ejemplo)

**Inputs:**
- Leer `discipline.md` completo.
- Leer la lista de 24 NN canonica desde `.claude/skills/discipline-step0a/SKILL.md` o la doctrina Discipline Loop del vault.

**Logica:**
- Por cada NN, verificar si `discipline.md` lo declara explicitamente y con suficiente especificidad.
- Marcar PASS / GAP / N/A segun el profile actual.

**Output JSON:**
```json
{
  "audit": "nn-coverage",
  "profile": "FAMILY_SYNC",
  "checks": [
    { "nn": 1, "status": "PASS", "evidence": "discipline.md §3 Data Model declara 4 tablas", "action": null },
    { "nn": 17, "status": "GAP", "evidence": null, "action": "Agregar §Security Baseline con 17.1-17.4" }
  ],
  "summary": { "pass": 18, "gap": 4, "na": 2 }
}
```

#### Audit 2, rls

**Inputs:**
- Glob `supabase/migrations/*.sql`.
- Para cada tabla detectada, parsear:
  - `ENABLE ROW LEVEL SECURITY`?
  - Cuantas policies?
  - Cubren SELECT/INSERT/UPDATE/DELETE?
  - Hay `auth.uid() IS NOT NULL` sin scoping a tenant/space?

**Output Markdown:**
| tabla | RLS | policies (S/I/U/D) | red flag | accion |
|---|---|---|---|---|

#### Audit 3, privacy-policy

**Inputs:**
- Leer `public/privacy-policy.md` o URL.
- Grep imports en `src/**` para detectar vendors (`@supabase/*`, `@sentry/*`, `resend`, `posthog-js`, `stripe`, etc.).
- Leer `discipline.md §Data Model` para retention declarado.

**Logica:**
- Vendors en codigo deben aparecer en privacy policy.
- Retention en policy debe coincidir con config real (Sentry default 90d).
- Vendors US deben mencionar transfer mechanism (SCCs o DPF).

**Output JSON:**
```json
{
  "vendors_in_code": ["supabase", "sentry"],
  "vendors_in_policy": ["supabase"],
  "missing_in_policy": ["sentry"],
  "retention_mismatches": [],
  "action_list": ["Agregar Sentry a §Third parties con retention 90d y SCCs"]
}
```

#### Audit 4, perf

**Comandos:**
```bash
npm run build
npx vite-bundle-visualizer  # o equivalente
npx unlighthouse --site http://localhost:4173
```

**Logica:**
- Comparar contra umbrales de NN 20 (Web: entry < 200KB gzip · Lighthouse Perf > 70 mobile).

**Output:**
- Tabla entry size real vs target.
- Top 5 deps por peso.
- Lighthouse score por categoria.
- Lista de acciones si falla algun umbral.

#### Audit 5, progress-drift

**Inputs:**
- Leer `progress.md §Last Completed Slices` y `§Current Status`.
- `git log --oneline -50`.
- `git log --name-only -20`.

**Logica:**
- Slices declarados done sin commit asociado.
- Commits sin entry en progress.md.
- Errores cerrados en progress.md ya resueltos en codigo.

**Output:**
- Tabla slice × commit × estado real.
- Lista de entries a agregar/actualizar/borrar en progress.md.

#### Audit 6-15

Seguir la estructura declarada en los Prompts de Auto-Auditoría del vault para cada uno. Schema de output viene en cada prompt original.

### Fase 3: Registrar en findings.md

Para cada audit corrido, agregar entry a `findings.md §Audits`. Si la seccion no existe, crearla.

Formato:
```markdown
## Audits

- <fecha YYYY-MM-DD HH:MM> · audit-<slug> · status=<PASS|GAP|N/A counts> · top-action=<accion mas critica si GAP>
- <fecha> · audit-<slug> · ...
```

Si un audit produce GAP critico (eg secrets commiteados, RLS desactivado en tabla con PII), tambien agregar entry a `findings.md §Risks`:
```markdown
- 2026-04-26 · CRITICAL · audit-secrets detecta API key en .env committeado · rotar y `git filter-repo` antes de proximo push.
```

### Fase 4: Modo `all`, agregado final

Si el usuario invoca `all`, despues de ejecutar los 15 audits:

```markdown
## Resumen agregado, /discipline-audit all (<fecha>)

Profile: <profile>
Total audits: 15
- PASS: <N>
- GAP: <N>
- N/A (skipped): <N>

### Top 5 acciones por impacto

1. <accion mas critica de los GAPs>
2. ...

### Audits con GAP

| Audit | GAPs | Top accion |
|---|---|---|
| nn-coverage | 4 | Agregar §Security Baseline |
| ... | ... | ... |

### Veredicto Gate D Launch

<READY si 0 GAPs criticos | NOT READY si hay GAPs en audits criticos para Gate D>

Audits criticos para Gate D: 1 (nn-coverage), 2 (rls), 3 (privacy-policy), 7 (test-coverage), 8 (secrets), 12 (a11y), 13 (error-handling).
Audits criticos para Gate E PROD: todos los anteriores + 4 (perf), 10 (deps-vulns), 11 (query-discipline), 15 (backup-restore).
```

### Fase 5: Resumen al usuario

Si invoco un audit individual:
```
Audit <slug> completado.
Status: PASS / GAP <N>
Top accion: <accion>
Detalle: findings.md §Audits.
```

Si invoco `all`:
```
Audit batch completado en <minutos> minutos.
PASS: <N>/15
GAP: <N>/15
N/A skipped: <N>/15

Top 3 acciones criticas:
1. ...
2. ...
3. ...

Veredicto Gate D Launch: <READY|NOT READY>

Detalle completo: findings.md §Audits.
```

---

## Manejo de errores

- Audit individual falla por input faltante (eg supabase/migrations/ no existe pero BACKEND=SUPABASE): registrar como skipped con razon, no abortar el batch en modo `all`.
- Comando externo falla (gitleaks, lighthouse, axe): instalar bajo demanda con `npx -y <package>` o saltar con notice.
- Output muy largo (eg `npm audit` con 100 vulns): truncar a top-20, crear entry adjunta en `.discipline/audits/<slug>-<fecha>.md` con detalle completo.
- Si el usuario interrumpe modo `all` a mitad, registrar audits ya corridos en findings.md y reportar progreso parcial.

---

## Reglas criticas

- No marcar items como `done` o `fixed` desde el skill. Solo audita; el usuario aplica fixes.
- No agregar entries falsas a findings. Si no hay GAP, audit-result va a findings.md §Audits con status PASS, no a §Risks.
- audit 8 (secrets): si detecta secret real, NO loggear el secret en findings; solo el patron y la accion (rotar + filter-repo).
- audit 3 (privacy-policy): si detecta vendor en codigo no listado en policy, alertar pero no escribir nada en publica/privacy-policy.md (eso es responsabilidad de `/discipline-legal-init`).
- Modo `all` no es para correr cada commit. Tipicamente pre-Gate D o retros mensuales.
- Tiempo objetivo: audit individual <1min, modo `all` 15-30 min.
