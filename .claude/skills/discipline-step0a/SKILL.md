---
name: discipline-step0a
description: "Automate Discipline Loop Step 0a: validate app idea with REAL web search competitor research (not invented), structured viability evaluation, and GO/NO-GO decision with evidence. Triggers on /discipline-step0a or 'validate idea' / 'validar idea'."
---

# /discipline-step0a - Automatizar Paso 0a del pipeline Discipline Loop

Este skill ejecuta el Paso 0a completo: evalua la idea de app con investigacion de mercado real, analisis de competidores, evaluacion estructurada, y decision GO/NO-GO. Si es GO, produce el IDEA_VALIDATION_PACKET para alimentar el Paso 1.

Usa WebSearch para investigacion de mercado real. No requiere otras herramientas externas.

## Lo que el usuario ve

1. El skill pide que describa su idea de app
2. Hace hasta 3 preguntas de clarificacion si la idea tiene vacios
3. Investiga competidores con busqueda web real
4. Evalua viabilidad con criterios estructurados
5. Da una recomendacion GO o NO-GO con evidencia
6. Si GO: genera IDEA_VALIDATION_PACKET

## Prerrequisitos

- Una idea de app (en lenguaje natural)
- WebSearch disponible (Claude Code lo incluye por defecto)
- No requiere Node.js ni repo existente (este paso es pre-template)

---

## Implementacion interna

### Fase 0: Obtener la idea

No hay inputs de archivos obligatorios. Este es el primer paso del pipeline.

**Si existe un proyecto previo:** leer `discipline.md` y `.discipline/packets/IDEA_VALIDATION_PACKET.md` por si ya hay una validacion previa que quiera actualizarse.

**Si no hay descripcion previa, pedir:**

```
Describeme tu idea de app:

- ¿Que problema resuelve?
- ¿Quien tiene este problema?
- ¿Como lo resuelven hoy?

Ejemplo: "Una app para freelancers con 3+ clientes que trackean horas 
manualmente en spreadsheets. Pierden 30min/dia cambiando entre clientes 
y herramientas de facturacion."
```

**Evaluar si la descripcion cubre los 4 ejes:**

1. **Problema**: ¿Queda claro que dolor resuelve?
2. **Usuario**: ¿Queda claro quien la usa y si hay roles distintos?
3. **Acciones clave**: ¿Queda claro que puede hacer el usuario?
4. **Datos**: ¿Queda claro que informacion se guarda?

Si faltan 1 o mas ejes, hacer hasta 3 preguntas de clarificacion en un solo mensaje. No preguntar una por una.

```
Antes de investigar, necesito aclarar:

1. ¿El tracker es solo para ti o para un equipo?
2. ¿Necesitas facturar directamente desde la app o solo trackear horas?

Con eso tengo lo que necesito.
```

Reglas:
- Maximo 3 preguntas
- Solo preguntar lo que no se puede asumir razonablemente
- No preguntar sobre tecnologia (eso se decide despues)
- Priorizar preguntas que afectan viabilidad

### Fase 1: Investigacion y evaluacion

**Sub-fase 1A: Evaluar problema y severidad**

Extraer de la descripcion:
1. Problema en 1 oracion (no vago, no "gestionar mejor")
2. Usuario especifico (no "cualquiera", no "todo el mundo")
3. Severidad (1-10):
   - 1-4: la gente convive sin molestarse
   - 5-7: usa workarounds activamente
   - 8-10: busca solucion activamente, pagaria

**Sub-fase 1B: Investigacion de mercado (WebSearch)**

Buscar 5 soluciones existentes. Usar estas consultas de busqueda:

1. "[problema] app" o "[problema] software"
2. "[problema] [usuario tipo] tool"
3. "best [categoria] app 2026"
4. Site-specific: "site:producthunt.com [categoria]", "site:alternativeto.net [categoria]"

Para cada competidor encontrado, documentar:

| Competidor | Que resuelve | Precio | Debilidad / gap |
|---|---|---|---|
| Nombre 1 | ... | Gratis / $X/mes | No cubre X |
| Nombre 2 | ... | $X/mes | Demasiado complejo para Y |
| ... | ... | ... | ... |

Si no se encuentran 5 competidores, documentar cuantos se encontraron y por que el mercado parece poco atendido.

**Sub-fase 1C: Analisis de gaps**

Basandose en los competidores encontrados:
1. ¿Que NO cubre ningun competidor bien?
2. ¿Hay un segmento de usuarios desatendido?
3. ¿Hay un caso de uso especifico que nadie resuelve?

**Sub-fase 1D: Evaluar diferenciador**

El diferenciador del usuario debe ser concreto, no "mejor UX". Ejemplos validos:
- "funciona offline" (cuando ningun competidor lo hace)
- "10x mas barato" (cuando los competidores cobran mucho)
- "especializado para [nicho]" (cuando los competidores son genericos)
- "integra con [herramienta]" (cuando hay un gap de integracion)

Si el diferenciador del usuario es vago, señalarlo y sugerir alternativas basadas en los gaps encontrados.

**Sub-fase 1E: Hipotesis MVP**

Formular: "Si construyo [X minimo], [usuario] hara [Y] en vez de [alternativa actual]."

Definir los 3 slices maximos para probar la hipotesis:
1. Slice 0: bootstrap (siempre)
2. Slice 1: accion core
3. Slice 2: diferenciador clave

Si la hipotesis necesita mas de 3 slices para probarse, el MVP es demasiado grande.

**Sub-fase 1F: Decision GO / NO-GO**

Aplicar los criterios:

**GO si:**
- [ ] Problema claro (1 oracion, no vago)
- [ ] Usuario especifico identificado
- [ ] Severidad >= 5
- [ ] Diferenciador real y concreto
- [ ] MVP demostrable en <= 3 slices
- [ ] (Si vende) Puede nombrar 3 personas que pagarian

**NO-GO si:**
- Problema difuso o poco claro
- Severidad < 5
- 3+ competidores maduros sin gap claro
- MVP requiere > 5 slices
- Diferenciador es solo "mejor UX" o "mas bonito"

### Fase 2: Generar output

**Si GO:**

Generar `.discipline/packets/IDEA_VALIDATION_PACKET.md`:

```markdown
# IDEA_VALIDATION_PACKET

STATUS: ready
SOURCE_STEP: Paso 0a
GENERATED: <fecha>

## Problema
<1 oracion clara>

## Usuario objetivo
<persona especifica>

## Severidad
<1-10 con justificacion>

## Soluciones existentes
| Competidor | Que resuelve | Precio | Debilidad |
|---|---|---|---|
| ... | ... | ... | ... |

## Gap identificado
<que no cubre ningun competidor>

## Diferenciador
<concreto y verificable>

## MVP: hipotesis central
"Si construyo [X], [usuario] hara [Y] en vez de [Z]."

## MVP: slices maximos
1. <slice 0: bootstrap>
2. <slice 1: core>
3. <slice 2: diferenciador>

## Decision
GO - <fecha>

## Evidencia
- <fuentes consultadas>
- <competidores evaluados>
- <criterios cumplidos>
```

**Si NO-GO:**

No generar packet. Presentar la decision con opciones:

```
Recomendacion: NO-GO

Razon principal: <razon>

Opciones:
1. Pivotar: cambiar usuario, problema o diferenciador
2. Reducir: hacer el MVP aun mas pequeño
3. Validar primero: hablar con 5 usuarios antes de construir
4. Descartar: buscar otra idea

¿Que prefieres?
```

Si el usuario quiere pivotar, volver a Fase 1 con la nueva direccion.

### Fase 3: Post-procesamiento

Si GO y hay un repo existente:
```bash
npm run discipline:assemble -- --step 1
npm run discipline:log -- --step 0a --tool "Claude + WebSearch" --notes "Automated via /discipline-step0a. Decision: GO."
```

Si GO y no hay repo todavia:
```
IDEA_VALIDATION_PACKET guardado.
Siguiente: elige tu lane en 08 - Elegir Lane → clona el Repo Template → ejecuta /discipline-step1.
```

### Fase 4: Resumen

```
Paso 0a completado.

Decision: <GO / NO-GO>
Competidores evaluados: <N>
Severidad: <N>/10
Diferenciador: <resumen>

<Si GO:>
Archivo generado: .discipline/packets/IDEA_VALIDATION_PACKET.md
Siguiente: elegir lane → clonar template → /discipline-step1

<Si NO-GO:>
Opciones presentadas. Esperando decision del operador.
```

---

## Manejo de errores

- Si WebSearch no esta disponible: advertir que la investigacion sera limitada. Generar el analisis con el conocimiento disponible pero marcar: "Investigacion sin WebSearch - validar manualmente las soluciones existentes."
- Si no se encuentran competidores: no asumir que el mercado esta vacio. Marcar: "Mercado potencialmente desatendido o terminos de busqueda insuficientes. Investigar manualmente."
- Si el usuario no responde las preguntas de clarificacion: generar la evaluacion con lo disponible, pero reducir el nivel de confianza de la decision.
- Si el usuario insiste en GO cuando los criterios dan NO-GO: respetar la decision pero documentar los riesgos explicitamente en el packet.

---

## Reglas criticas

- Usar WebSearch para investigacion real. No inventar competidores ni precios.
- No inflar la severidad para que salga GO. Ser honesto.
- No inventar diferenciadores. Si el usuario no tiene uno claro, decirlo.
- El MVP debe caber en 3 slices. Si no cabe, el scope es demasiado grande.
- No preguntar sobre tecnologia. Eso se decide en Elegir Lane y Paso 1.
- La decision GO/NO-GO es una recomendacion. El operador decide. Si insiste en GO, documentar los riesgos.
- Las fuentes consultadas deben listarse en el packet para trazabilidad.
- Este paso deberia tomar 30 minutos maximo. No sobreinvestigar.
