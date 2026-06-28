---
name: discipline-step2-5
description: "Automate Discipline Loop Step 2.5 (AI Studio Lane): iterate prompt + schema + evals JSONL + LLM Contract Gate + AI_IMPLEMENTATION_PACKET + DISCIPLINE_MD_PATCH_BLOCK. Triggers on /discipline-step2-5, 'run step 2.5', 'ejecutar paso 2.5', 'ai studio lane'."
---

# /discipline-step2-5 - Automatizar Paso 2.5 (AI Studio Lane) del pipeline Discipline Loop

Este skill ejecuta el Paso 2.5 completo: iterar prompt + schema con wrapper `ok/data/error`, generar evals JSONL, validar contra LLM Contract Gate, y producir `AI_IMPLEMENTATION_PACKET` + `DISCIPLINE_MD_PATCH_BLOCK` para alimentar Paso 5.

Solo aplica cuando `AI_FEATURES=enabled` en discipline.md. Si esta `none`, saltar este paso completamente.

El skill NO sustituye Google AI Studio. La iteracion del prompt sigue siendo humana en aistudio.google.com. El skill estructura el proceso, valida outputs, y empaqueta los artefactos.

## Lo que el usuario ve

1. El skill verifica que `AI_FEATURES=enabled` y lee `STEP_2_5_AI_PACKET` del Paso 1.
2. Guia 7 fases: definicion → schema → prompt → evals → contract → packet → patch.
3. En cada fase pide outputs concretos (paste de Studio o respuestas estructuradas).
4. Valida cada output contra los NN aplicables (#11 AI Studio Lane, #12 LLM Contract Gate).
5. Genera `AI_IMPLEMENTATION_PACKET.md` y `DISCIPLINE_MD_PATCH_BLOCK`.
6. Prepara `paso-5-input.md` con contexto de IA listo para Paso 5.

## Prerrequisitos

- `discipline.md §0` con `AI_FEATURES=enabled` (si no, abortar).
- `STEP_2_5_AI_PACKET.md` o `STEP_2_5_AI_PACKET.borrador.md` en `.discipline/packets/` (generado por Paso 1).
- Acceso a Google AI Studio (aistudio.google.com) o equivalente para iterar prompt manualmente.
- `prompts/_templates/schema.json` existe en el template.
- `tools/llm_eval.js` existe (verificable con `npm run ai:eval --help`).

---

## Implementacion interna

### Fase 0: Verificar precondiciones

Leer discipline.md, extraer `AI_FEATURES`. Si `none` o ausente:
```
AI_FEATURES esta en `none` en discipline.md. Paso 2.5 no aplica.

Si tu app usa IA, primero cambia AI_FEATURES a 'enabled' en discipline.md y vuelve a /discipline-step1 para regenerar STEP_2_5_AI_PACKET.

Si tu app no usa IA, salta directamente a /discipline-step3 (UI) o /discipline-step4 (slices).
```

Si STEP_2_5_AI_PACKET no existe:
```
Falta STEP_2_5_AI_PACKET. Vuelve a /discipline-step1 para generarlo.
```

### Fase 1: Definicion de la feature de IA

Leer STEP_2_5_AI_PACKET. Extraer:
- Caso de uso (que pide el usuario, que entrega la IA)
- Provider primario y rol de modelo (`Premium Reliable - Trabajo Mecánico`, `Premium Reliable - Implementación`, `Premium Reliable - Decisiones Críticas` o `Frontier-Budget - Implementación`). Resolver IDs concretos en `09 - Referencia/01 - Registro Vivo de Modelos y Herramientas.md`
- Provider fallback determinista (regla simple si LLM falla)
- Latency budget p95 (tipicamente <3s para UI sincrona, <10s async)
- Cost budget per request (tipicamente <$0.01 LITE, <$0.05 FAMILY_SYNC)

Pedir al usuario confirmar cada uno o ajustar:

```
Definicion de la feature de IA:

Caso: <extraido>
Provider: <extraido>
Fallback determinista: <extraido o "no definido">
Latency p95: <extraido>
Cost per request: <extraido>

¿Algo cambia? Responde con ajustes o "OK".
```

Si fallback determinista no esta definido, exigirlo (NN #11 lo requiere):
```
Fallback determinista obligatorio (NN #11). Define una regla simple que aplique cuando:
- LLM falla (timeout, error, schema invalido).
- Cost budget excedido.
- Latency budget excedido.

Ejemplo: "Si la IA falla, usar la primera categoria por orden alfabetico."
```

### Fase 2: Schema con wrapper ok/data/error

Leer `prompts/_templates/schema.json`. Es el template base obligatorio:

```json
{
  "type": "object",
  "properties": {
    "ok": { "type": "boolean" },
    "data": { ... },
    "error": {
      "type": "object",
      "properties": {
        "code": { "type": "string" },
        "message": { "type": "string" }
      }
    }
  },
  "required": ["ok"]
}
```

Pedir al usuario el schema especifico de su feature (la parte `data`):

```
Define el schema del campo `data` para tu feature.

Ejemplo (para clasificador):
{
  "category": { "type": "string", "enum": ["urgent", "normal", "low"] },
  "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
}

Pega tu schema:
```

Generar `prompts/<feature-name>/schema.json` con wrapper completo. Validar con AJV (ya en deps).

### Fase 3: Prompt iteration en AI Studio

Esta fase es manual. El skill genera el prompt base + invitacion a iterar:

```
Abre Google AI Studio: https://aistudio.google.com/

1. Crea un nuevo prompt con structured output activado.
2. Pega este prompt base:

[prompt base generado por el skill, incluye system prompt + few-shot examples si aplica]

3. Itera con 3-5 ejemplos reales. Verifica que:
   - El output sigue el schema exacto.
   - Los casos edge (input vacio, ambiguo, hostil) producen `ok: false` con error claro.
   - El fallback se activa cuando debe (no se invoca para casos validos).

4. Cuando estes satisfecho, pega aqui el prompt final.
```

Capturar el prompt final del usuario.

### Fase 4: Evals JSONL

Pedir 5-10 casos de prueba en formato JSONL:

```
Genera 5-10 evals en JSONL. Formato:

{"input": "<input real>", "expected_ok": true, "expected_data": {...}, "expected_error_code": null}
{"input": "<input edge>", "expected_ok": false, "expected_error_code": "INVALID_INPUT"}

Mas casos = mejor cobertura. Incluye al menos:
- 3 happy path con inputs distintos.
- 2 edge cases (input vacio, ambiguo, hostil).
- 1 caso que activa el fallback determinista.

Pega los evals:
```

Guardar en `evals/<feature-name>.jsonl`. Validar formato con AJV.

### Fase 5: LLM Contract Gate

Correr los evals con el provider real:

```bash
npm run ai:eval -- --feature=<feature-name>
```

Capturar resultado. Si pass rate < 90%, no cerrar el paso:

```
LLM Contract Gate falla: pass rate <X>% (minimo 90%).

Casos que fallaron:
<lista>

Opciones:
1. Iterar prompt en AI Studio (vuelve a Fase 3).
2. Ajustar evals si tienen expectativas incorrectas.
3. Cambiar provider si Flash es insuficiente para la complejidad.
4. Aceptar pass rate <90% solo si LITE y dejas registro en findings.md (no recomendado).
```

Si pass rate >=90%, generar reporte de evals y continuar.

### Fase 6: AI_IMPLEMENTATION_PACKET

Generar `.discipline/packets/AI_IMPLEMENTATION_PACKET.md`:

```markdown
## AI_IMPLEMENTATION_PACKET

STATUS: validated
SOURCE_STEP: Paso 2.5
GENERATED: <fecha>

### Feature
- <nombre>

### Provider
- Primario: <provider>
- Fallback determinista: <regla>

### Schema
- Path: prompts/<feature>/schema.json
- Wrapper: ok/data/error obligatorio (NN #11)

### Prompt
- Path: prompts/<feature>/prompt.md
- Sistema + few-shot examples
- Iterado en AI Studio: <fecha de iteracion>

### Evals
- Path: evals/<feature>.jsonl
- Casos: <N>
- Pass rate: <%>

### LLM Contract Gate
- Run: npm run ai:eval -- --feature=<feature>
- Status: PASS

### Budgets
- Latency p95 declarado: <ms>
- Cost per request declarado: <$>

### Cross-provider note
- Si provider final != Gemini, evals DEBEN re-correrse con provider real antes de cerrar Paso 5 (NN #12).
```

### Fase 7: DISCIPLINE_MD_PATCH_BLOCK

Generar patch block para `discipline.md §AI Contracts`:

```markdown
## DISCIPLINE_MD_PATCH_BLOCK

### Target
- discipline.md §AI Contracts

### Mode
- replace_section

### Content
[bloque completo de seccion AI Contracts con: feature, provider, fallback, schema path, prompt path, evals path, latency budget, cost budget]
```

Aplicar:
```bash
npm run discipline:patch
```

### Fase 8: paste-ready siguiente

```bash
npm run discipline:assemble
```

Esto genera `paste-ready/paso-3-input.md` (si UI necesaria) o `paso-4-input.md` (si pasa directo a slices).

### Fase 9: Resumen

```
Paso 2.5 (AI Studio Lane) completado.

Feature: <nombre>
Provider: <provider> + fallback <regla>
Schema validado: prompts/<feature>/schema.json
Evals: <N> casos, pass rate <%>
LLM Contract Gate: PASS

Archivos generados:
- prompts/<feature>/prompt.md
- prompts/<feature>/schema.json
- evals/<feature>.jsonl
- AI_IMPLEMENTATION_PACKET.md
- DISCIPLINE_MD_PATCH_BLOCK aplicado

Siguiente: /discipline-step3 (UI) o /discipline-step4 (slices), segun aplique.

CRITICO: si en Paso 5 cambias el provider, re-corre `npm run ai:eval` antes de cerrar el slice (NN #12).
```

---

## Manejo de errores

- AI Studio inaccesible: ofrecer fallback con Claude Artifacts o iteracion en daily driver con structured output.
- Schema invalido (AJV falla): mostrar error de AJV, pedir correccion.
- Evals JSONL malformado: mostrar linea problematica, pedir correccion.
- LLM Contract Gate <90%: NO continuar, redirigir a Fase 3 o 4.
- Provider cuota agotada: ofrecer cambiar a un rol más barato vigente en el Registro Vivo (89) o esperar.

---

## Reglas criticas

- Wrapper `ok/data/error` es obligatorio (NN #11). No aceptar schemas planos.
- Fallback determinista es obligatorio (NN #11). No aceptar "el LLM nunca falla".
- LLM Contract Gate >=90% pass rate es obligatorio antes de cerrar Paso 2.5 (NN #12).
- Cross-provider: si provider final difiere del de iteracion, re-correr evals (NN #12).
- No iterar prompt sin medir: cada cambio en prompt debe tener evals que lo validen.
- No saltarse Paso 2.5 cuando AI_FEATURES=enabled: invariablemente lleva a slices Paso 5 con prompts inline contradictorios.
- Tiempo objetivo: 30-90 min para feature simple, 2-4 h para feature compleja con multiples casos edge.
