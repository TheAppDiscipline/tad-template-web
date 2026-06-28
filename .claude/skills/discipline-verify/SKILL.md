---
name: discipline-verify
description: "Opt-in advanced verification fan-out. Runs the Discipline Loop audit subagents in parallel (rls, security, scope, a11y, architecture, legal/product), collects their JSON envelopes, and merges them deterministically into one advisory report. NOT part of npm run gate; requires Claude Code (LLM, costs tokens). Triggers on /discipline-verify, 'fan-out verify', 'verificacion avanzada'."
---

# /discipline-verify - Fan-out de verificacion (advisory, opt-in)

Corre los subagentes de auditoria del Discipline Loop **en paralelo** y fusiona sus resultados en un solo reporte. Es **verificacion opt-in / gate avanzado**, NO el gate base: `npm run gate` sigue determinista y LLM-free, y este skill no lo toca.

> **Advisory, no auto-bloqueo.** El reporte recomienda; el humano decide. Ningun subagente bloquea por si mismo. `blocking` es siempre `false`.

## Costo y dependencia (leer antes de correr)

- **Requiere Claude Code** (runtime de subagentes). No corre como script de shell ni en un comprador sin agente.
- **Cuesta tokens:** hasta 6 subagentes (5 en modelo `haiku`, 1 en `sonnet` para arquitectura; security-reviewer es `sonnet`). Corre el subconjunto aplicable al slice, no siempre los 6.
- La **fusion y validacion** del resultado SI es determinista (`tools/discipline/audit-merge.ts`), sin LLM.

## Que hace (pasos para el agente)

1. **Elige el timestamp** `TS` con formato `YYYYMMDD-HHMMSS` (UTC) y crea la carpeta `.discipline/audits/raw/<TS>/`.
2. **Elige los subagentes aplicables** segun lo que toco el slice (por defecto, todos los que apliquen):
   - `discipline-scope-guard` y `discipline-security-reviewer`: casi siempre al cerrar un slice.
   - `discipline-rls-auditor`: si hubo cambios en `supabase/migrations/`.
   - `discipline-a11y-checker`: si hubo cambios de UI (`src/**/*.tsx` o estilos).
   - `discipline-architecture-auditor`: si se agregaron deps, modulos o se toco `src/lib/backend/**`.
   - `discipline-legal-product-auditor`: si el profile es LAUNCH o PROD, o al productizar.
3. **Invocalos EN PARALELO** con el tool `Agent()` (varias llamadas en un mismo turno). Un solo writer por slice: este fan-out es solo de VERIFICACION, no escribe codigo de producto.
4. **Guarda cada envelope** que devuelve un subagente, tal cual, en `.discipline/audits/raw/<TS>/<agent>.json` (un archivo por subagente; el nombre del archivo debe ser el `agent` del envelope). El agente padre escribe estos archivos porque los subagentes no tienen herramienta de escritura uniforme.
5. **Fusiona deterministicamente**, pasando en `--expected` la lista EXACTA de subagentes que decidiste correr en el paso 2 (separados por coma):
   ```bash
   npm run discipline:audit-merge -- \
     --raw-dir .discipline/audits/raw/<TS> \
     --expected discipline-scope-guard,discipline-security-reviewer,...
   ```
   Esto valida cada envelope contra `discipline.agent_audit.v1`, strippea fences defensivamente, computa el status global y escribe `.discipline/audits/<TS>-fanout.json` + un resumen legible.
   **`--expected` es importante:** si un subagente que ibas a correr no entrego envelope (fallo u omitido), el merge lo lista en `missing_agents`, sube el status global a `WARN` como minimo, y la auditoria NO se reporta como `PASS` limpio. Sin `--expected`, el merge no puede saber que falto.
6. **Presenta el resumen** al usuario: status global (`PASS | WARN | FAIL`), conteos por severidad, y los findings `critical` primero. Recuerda que es advisory.

## Status global

- `FAIL` si algun subagente devolvio `FAIL` (>=1 finding `critical`).
- `WARN` si ninguno `FAIL` pero alguno `WARN` (solo `moderate`/`minor`).
- `PASS` si todos `PASS`.

## Degradacion (sin LLM / errores)

- Si no hay Claude Code, este skill no puede correr: los subagentes son del runtime LLM. Di esto claro; no finjas un resultado.
- Si un subagente falla o no devuelve un envelope, NO inventes uno: omite su archivo. Como pasaste `--expected`, el merge lo marcara en `missing_agents` y subira el status a `WARN`, asi la auditoria parcial queda visible en vez de leerse como `PASS`.
- Si un envelope no cumple `discipline.agent_audit.v1`, `audit-merge` **falla claro (exit 2)** y no fusiona: es drift del contrato, hay que arreglar el subagente, no ignorarlo.

## Uso en CI (opt-in)

Para un gate avanzado opcional en CI, corre el merge con `--strict`: sale con codigo != 0 si el status global es `FAIL`. Sigue sin formar parte de `npm run gate`.

```bash
npm run discipline:audit-merge -- --raw-dir .discipline/audits/raw/<TS> --strict
```

## Prerrequisitos

- Repo con `.discipline/` y los subagentes en `.claude/agents/discipline-*.md`.
- Claude Code disponible (los subagentes corren via `Agent()`).
- `tools/discipline/audit-merge.ts` presente (paso determinista de fusion).

## No hace

- No forma parte de `npm run gate` ni lo modifica.
- No aplica fixes ni escribe codigo de producto.
- No bloquea por si mismo (advisory); el `--strict` para CI es decision explicita del usuario.
- No garantiza "calidad" ni "compliance": agrega recomendaciones de auditores, nada mas.
