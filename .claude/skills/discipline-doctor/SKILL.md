---
name: discipline-doctor
description: "Diagnose Discipline Loop project health in 30 seconds. Reports profile, last gate, pending packets/patches, progress.md drift, scorecard status. Triggers on /discipline-doctor, 'check project status', 'estado del proyecto'."
---

# /discipline-doctor - Diagnostico rapido del proyecto Discipline Loop

Este skill recopila el estado actual del proyecto en una sola pasada y devuelve un reporte tabular legible. No modifica archivos. No corre gates pesados. No requiere internet.

## Lo que el usuario ve

1. El skill lee 5 fuentes: `discipline.md`, `progress.md`, `.discipline/packets/`, `.discipline/patches/pending/`, git status.
2. Si `PROFILE>=LAUNCH`, intenta leer `.discipline/scorecard.yaml`.
3. Reporta tabla con: profile actual, ultimo gate run, packets generados/aplicados, patches pendientes, drift `progress.md` vs git, scorecard status.
4. Sugiere proxima accion concreta (un solo paso).

## Prerrequisitos

- Proyecto inicializado (existe `.discipline/` y `discipline.md`).
- Si el proyecto esta recien clonado sin `.discipline/`, decirlo y sugerir `npm run discipline:hydrate`.
- No requiere ningun gate verde para correr.

---

## Implementacion interna

### Fase 0: Verificar que el proyecto este inicializado

Verificar que existan:
- `discipline.md` en raiz
- `.discipline/` directorio
- `package.json` con scripts `discipline:*`

Si falta alguno:
```
El proyecto no parece tener Discipline Loop inicializado.

Falta: <archivo o directorio>

Posibles causas:
1. Repo recien clonado sin hydrate. Corre: npm run discipline:hydrate
2. No es un template Discipline Loop. Verifica que clonaste tad-template-{web,mobile,desktop,extension}.

Detente aqui hasta resolver.
```

### Fase 1: Extraer PROFILE y switches

Leer `discipline.md` y extraer la seccion `§0 Switches` (o equivalente). Capturar:
- `PROFILE` (LITE / FAMILY_SYNC / LAUNCH / PROD)
- `LANE` (WEB / MOBILE / DESKTOP / EXTENSION)
- `BACKEND_PROVIDER`
- `AUTH_MODE`
- `AI_FEATURES`

Si `PROFILE` no esta declarado, marcar warning: "discipline.md no declara PROFILE. Default FAMILY_SYNC implicito por NN #6, pero recomendable explicitarlo."

### Fase 2: Leer `progress.md`

Capturar:
- Numero total de lineas
- Numero de slices marcados done (count de `- [x]` o `## Slice` con status done)
- Ultimas 5 entries (titulo y fecha si tiene)
- Si tiene seccion `§Open Errors`, listarla

Si `progress.md > 150 lineas`: warning sobre NN #8 (Context Management).

### Fase 3: Inventariar `.discipline/packets/`

Listar archivos en `.discipline/packets/`. Clasificar:
- Packets validados (extension `.md` sin `.borrador` en nombre)
- Packets en borrador (`.borrador.md`)
- Packets superseded (`.superseded.md`)

Detectar pares anomalos:
- Si existe `X.borrador.md` pero no `X.md`, el borrador no fue validado todavia.
- Si existen ambos `X.borrador.md` y `X.md`, el borrador no fue limpiado tras validacion.

### Fase 4: Inventariar `.discipline/patches/pending/`

Contar archivos en `.discipline/patches/pending/`. Si hay alguno:
- Listar nombres de archivos
- Marcar como BLOCKER si count > 0 (no se puede avanzar sin aplicar)

Sugerir: `npm run discipline:patch` (o `npm run discipline:patch:dry-run` para preview).

### Fase 5: Git status y log

Ejecutar (mentalmente o con Bash):
- `git status --short` para ver cambios sin commit
- `git log --oneline -5` para ver ultimos 5 commits
- `git branch --show-current` para branch actual

Detectar drift entre `progress.md` y git log:
- Slices declarados done en `progress.md` que NO tienen commit asociado
- Commits relevantes que NO aparecen en `progress.md`

### Fase 6: Scorecard YAML (solo si PROFILE >= LAUNCH)

Si `PROFILE` es LAUNCH o PROD:
- Verificar que `.discipline/scorecard.yaml` existe
- Si existe, intentar correr `npm run discipline:validate:launch` (o `:prod`) y capturar exit code + output
- Si no existe, marcar BLOCKER: "PROFILE=LAUNCH+ requiere scorecard.yaml. Crea desde la plantilla del vault (Launch vs PROD + Scorecard as Code)."

### Fase 7: Generar reporte

Output en formato tabular:

```markdown
# Discipline Loop · Estado del proyecto

**Generado:** <fecha actual>
**Branch:** <branch git>
**Lane:** <LANE>
**Profile:** <PROFILE>

## Resumen

| Area | Estado | Detalle |
|---|---|---|
| Profile declarado | OK / WARNING | <PROFILE o "no declarado, default FAMILY_SYNC"> |
| `progress.md` | OK / WARNING | <N lineas; warning si >150> |
| Slices done | <N> | Ultimo: <titulo del ultimo slice> |
| Packets validados | <N> | <lista corta de los principales> |
| Packets en borrador | <N> | <lista; 0 si no hay> |
| Patches pendientes | OK / BLOCKER | <N archivos en `.discipline/patches/pending/`> |
| Errores abiertos | <N> | <de progress.md §Open Errors> |
| Cambios sin commit | <N> | <de git status --short> |
| Drift progress vs git | OK / WARNING | <descripcion si hay drift> |
| Scorecard YAML | N/A o OK / BLOCKER | <solo si PROFILE>=LAUNCH; "no aplica" si LITE/FAMILY_SYNC> |

## Bloqueadores

<si hay BLOCKERS, listarlos en orden de impacto. Si no hay, decir "Ningun bloqueador detectado.">

## Warnings

<si hay warnings, listarlos. Si no hay, decir "Sin warnings.">

## Proxima accion sugerida

<un solo paso concreto, basado en el estado>
```

**Reglas para "Proxima accion sugerida":**
- Si hay patches pendientes, siempre sugerir aplicarlos primero.
- Si hay packets en borrador sin validar, sugerir el paso productor que debe validarlos.
- Si scorecard YAML falta y PROFILE>=LAUNCH, sugerir crearlo.
- Si todo OK y hay slice next en `task_plan.md`, sugerir abrir `paste-ready/paso-X-input.md` correspondiente.
- Si todo OK y no hay slice next, sugerir corre el siguiente paso del pipeline o cierra el batch con DEPLOY_READINESS_PACKET.

### Fase 8: Logging

No actualizar `progress.md`. No correr gates. No tocar packets.

Solo registrar la corrida en `.discipline/run-log.md` con una entry minima:

```markdown
- <fecha> · /discipline-doctor · status: <profile>/<N blockers>/<N warnings>
```

Si `discipline:log` esta disponible:
```bash
npm run discipline:log -- --step doctor --tool "/discipline-doctor" --notes "blockers=N, warnings=M"
```

Si no, agregar manualmente la linea al final de `run-log.md`.

---

## Manejo de errores

- Si `discipline.md` no parsea: reportar el error de parseo y mostrar las primeras 30 lineas para diagnostico humano.
- Si `package.json` no tiene scripts `discipline:*`: el proyecto puede ser pre-Wave 3 o no ser template oficial. Reportar version detectada (lee version del package.json).
- Si `npm run discipline:validate:launch` falla con exit !=0 pero produce output: incluir las primeras 20 lineas del output en el reporte como "Errores del scorecard".
- Si git no esta inicializado: marcar git status como N/A y seguir.

---

## Reglas criticas

- No modificar archivos. Solo lectura.
- No correr `npm run gate` ni `gate:full` (son pesados, el doctor es ligero).
- No invocar otros skills.
- El reporte debe caber en ~30 lineas legibles. Si requieres detallar mas, ofrecer profundizacion bajo pedido ("¿Quieres detalle de los packets?").
- El reporte debe ser interpretable por un no-programador: usar terminos del glosario (ver el glosario del vault), no jerga interna del tooling.
- Sugerir siempre UNA proxima accion, no una lista. Si hay multiples bloqueadores, priorizar el que destrabe el resto.
- Tiempo total objetivo: 30 segundos de output al usuario.
