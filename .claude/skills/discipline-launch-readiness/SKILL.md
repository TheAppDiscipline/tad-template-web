---
name: discipline-launch-readiness
description: "Validate Gate D (Launch) or Gate E (PROD) readiness from .discipline/scorecard.yaml. Wraps discipline:validate:launch parser into a human-readable table for non-technical users. Triggers on /discipline-launch-readiness, 'check launch readiness', 'verificar listo para lanzar'."
---

# /discipline-launch-readiness - Validar readiness de Gate D Launch o Gate E PROD

Este skill ejecuta el parser scorecard-as-code (`discipline:validate:launch` o `:prod`), interpreta el output crudo en una tabla legible, y devuelve "listo para lanzar" o "faltan estos N items" con accion concreta por cada gap.

NOTA: el skill NO modifica el scorecard.yaml. Solo lo lee y reporta. Si faltan items, el usuario los marca como `done` con evidencia despues de cumplirlos.

## Lo que el usuario ve

1. El skill verifica que `.discipline/scorecard.yaml` exista. Si no, ofrece generar el skeleton desde la plantilla del vault (Launch vs PROD + Scorecard as Code).
2. Detecta el modo automaticamente leyendo `meta.profile_target` del YAML, o pregunta al usuario si es ambiguo.
3. Corre el parser correspondiente y captura output + exit code.
4. Procesa el output en tabla legible: id, nombre, status, evidencia, accion si falla.
5. Resume al final: "X/Y criticos OK, ready" o "lista de items pendientes con prioridad".
6. Registra el run en `findings.md §Audits` automaticamente.

## Prerrequisitos

- `.discipline/scorecard.yaml` existe (si no, ofrece crearlo).
- `tools/discipline/validate-scorecard.ts` y scripts `discipline:validate:launch|prod` disponibles en package.json.
- `discipline.md §0` con PROFILE definido (LAUNCH o PROD para que valide algo aplicable).
- `js-yaml` instalado (es devDep del template; si falta, `npm install`).

---

## Implementacion interna

### Fase 0: Verificar PROFILE y scorecard.yaml

Leer `discipline.md`. Extraer `PROFILE`. Si es `LITE` o `FAMILY_SYNC`, advertir:

```
PROFILE actual: <profile>. Gate D/E aplica solo a LAUNCH o PROD.

Si quieres validar readiness para subir a LAUNCH:
1. Define los criterios en `.discipline/scorecard.yaml` (plantilla en el vault, Launch vs PROD + Scorecard as Code §4.1).
2. Marca status `done` cuando completes cada item con su evidencia.
3. Vuelve a correr este skill cuando estes listo para Gate D.

Detente aqui o continua con `--force` para ver el dry-run del parser.
```

Si `PROFILE` es LAUNCH o PROD, verificar que `.discipline/scorecard.yaml` exista. Si no:

```
.discipline/scorecard.yaml no existe. PROFILE=<profile> requiere scorecard.

Opciones:
1. Generar skeleton ahora (creo el archivo con la plantilla canonica del vault, 65a §4.1; tu lo llenas con evidencia).
2. Detenerme y revisas la doctrina primero.

Eleccion: <1|2>
```

Si elige 1, generar skeleton minimal con los 8 criticos de Launch + 7 recomendados (segun 65a §3) + meta.profile_target.

### Fase 1: Detectar modo

Leer `meta.profile_target` del scorecard.yaml. Si:
- `LAUNCH` → modo es `launch`.
- `PROD` → modo es `prod` (incluye launch + prod criticos).
- Ausente o incoherente con PROFILE de discipline.md → preguntar al usuario que modo quiere.

### Fase 2: Correr parser

```bash
npm run discipline:validate:<mode>
```

Capturar stdout, stderr, exit code.

Si falla por `js-yaml` no instalado: pedir al usuario `npm install` antes de continuar.

Si falla por scorecard.yaml malformado: mostrar error de parser y referir al schema del vault (65a §4.1).

### Fase 3: Post-procesar output a tabla legible

El parser devuelve:
- Cuantos criticos `done` / `not_done` / `deferred`.
- Cuantos recomendados `done` / `not_done`.
- Items con `expires_on` pasado.
- Condicionales aplicables (solo en mode=prod).

Reformatear en tabla Markdown:

```markdown
## Gate <D|E> Launch Readiness Report

**Profile target:** <LAUNCH|PROD>
**Generado:** <fecha>
**Scorecard:** .discipline/scorecard.yaml (last_updated: <fecha del meta>)

### Criticos (bloquean si no estan done)

| ID | Nombre | Status | Evidencia | Accion si falla |
|---|---|---|---|---|
| L01 | Privacy Policy publicada en /privacy | DONE | URL: https://app.com/privacy | OK |
| L02 | ToS publicado en /terms | NOT_DONE | (vacio) | Crear con `/discipline-legal-init` o copiar plantilla en `Plantillas/Plantillas Legales/terms-of-service.md.template` |
| ... | ... | ... | ... | ... |

### Recomendados (warning, no bloquean)

| ID | Nombre | Status | Evidencia | Notas |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

### Resumen

- Criticos: <N done> / <total> · <bloqueadores: cuantos pendientes>
- Recomendados: <N done> / <total>
- Deferred con expires_on pasado: <N> (escalan a fail hard)
- Condicionales aplicables: <N> (solo PROD)

### Veredicto

<READY | NOT READY>

<Si NOT READY:>
Bloqueadores en orden de impacto:
1. <item ID> · <nombre> · <accion concreta>
2. ...

Tiempo estimado para cerrar: <suma de esfuerzos por item>.

<Si READY:>
Gate <D|E> verde. Puedes activar PROFILE=<LAUNCH|PROD> en discipline.md y proceder con release.

Recuerda:
- Re-correr este skill antes de cada release subsecuente.
- Items con expires_on requieren retrospective antes de la fecha.
```

### Fase 4: Registrar en findings.md

Agregar entry al `findings.md §Audits`:

```markdown
- <fecha> · /discipline-launch-readiness · mode=<launch|prod> · veredicto=<READY|NOT_READY> · criticos=<N done>/<total> · bloqueadores=<lista corta>
```

Si `findings.md §Audits` no existe, crearla.

### Fase 5: Resumen al usuario

Si READY:
```
Gate <D|E> Launch Readiness: READY

<N>/<total> criticos done. Puedes proceder con el release.

Siguiente:
- Activar PROFILE en discipline.md (si todavia no es <LAUNCH|PROD>).
- Correr `npm run gate:strict` antes del release.
- Smoke en device real con cuenta limpia post-deploy.
```

Si NOT READY:
```
Gate <D|E> Launch Readiness: NOT READY

<N> bloqueadores criticos:
1. <id> · <nombre> · <accion>
2. ...

Sugerencia: cierra el primer bloqueador, vuelve a correr este skill. La curva no debe ser bajar bloqueadores en lote sin verificar.

Si algun bloqueador requiere herramientas o conocimiento fuera de tu alcance, considera:
- /discipline-legal-init para Privacy Policy + ToS + breach runbook.
- /discipline-audit prompt-7 para test coverage.
- /discipline-audit prompt-12 para a11y WCAG AA.
- 81 - Resolucion Rapida de Problemas si te atascas en algo no documentado.
```

---

## Manejo de errores

- `validate-scorecard.ts` no existe: el template no es post-Wave 3.1. Sugerir actualizar a la version actual o instalar el script manualmente según el vault (Estado de Implementación).
- Parser exit code != 0 pero output vacio: probablemente excepcion. Mostrar stderr y referir al usuario a `npm run discipline:validate:launch -- --verbose` para diagnostico.
- `expires_on` pasado en muchos items recomendados: warning, no fail. Sugerir retrospective de scope.
- meta.profile_target ausente: preguntar al usuario que profile target eligio (LAUNCH o PROD).

---

## Reglas criticas

- No marcar items como `done` desde el skill. Solo el usuario decide cuando un item esta cumplido (con evidencia).
- No saltar items criticos. `deferred` en criticos = fail hard, sin excepciones.
- Recomendados pueden estar `deferred` con `deferred_reason` + `expires_on` futuro.
- Si `expires_on` pasa, escalan a `fail hard` automaticamente (sin necesidad de re-marcar).
- No desactivar reglas de NN para pasar el gate. Si una regla no aplica, marca `not_applicable` con justificacion en `notes`.
- Tiempo objetivo: 30 segundos para validar y reportar. Si toma mas, probablemente el scorecard YAML es muy grande o el parser tiene bug.
