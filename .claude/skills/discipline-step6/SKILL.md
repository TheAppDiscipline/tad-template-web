---
name: discipline-step6
description: "Automate Discipline Loop Step 6: deploy build candidate, verify with real usage, and produce POST_DEPLOY_FEEDBACK_PACKET. Triggers on /discipline-step6 or 'run step 6' / 'ejecutar paso 6'."
---

# /discipline-step6 - Automatizar Paso 6 del pipeline Discipline Loop

Este skill ejecuta el Paso 6 completo: verifica gates, ejecuta build y deploy segun el lane, corre verificacion automatizada si Playwright MCP esta disponible, captura feedback del operador, y produce el POST_DEPLOY_FEEDBACK_PACKET.

Este skill es mas interactivo que los anteriores: ejecuta comandos reales y pide confirmacion del operador en varios puntos.

## Lo que el usuario ve

1. El skill verifica que existan los inputs del Paso 5
2. Corre gates y build
3. Propone el comando de deploy segun lane y hosting
4. Ejecuta verificacion post-deploy (Playwright si disponible, manual si no)
5. Hace preguntas de feedback al operador
6. Genera POST_DEPLOY_FEEDBACK_PACKET y patch blocks
7. Ensambla paste-readies y reporta siguiente paso

## Prerrequisitos

- Paso 5 completado (`DEPLOY_READINESS_PACKET` en `.discipline/packets/`)
- Build candidata lista (gates pasando)
- Node.js + npm
- Credenciales de deploy configuradas segun lane (Vercel, EAS, Railway, etc.)

---

## Implementacion interna

### Fase 0: Verificar inputs

Leer estos archivos. Si el obligatorio no existe, detenerse.

**Obligatorio (uno de los dos):**
1. `.discipline/paste-ready/paso-6-input.md` (preferido)
2. `.discipline/packets/DEPLOY_READINESS_PACKET.md` (fuente directa)

Si ninguno existe:
```
Falta el DEPLOY_READINESS_PACKET. Completa los slices en Paso 5 primero.
```

**Contexto del proyecto (leer siempre):**
3. `discipline.md` — extraer: LANE, PROFILE, HOSTING, AUTH_MODE, BACKEND_PROVIDER, AI_FEATURES
4. `task_plan.md`
5. `findings.md`
6. `progress.md`

**Opcionales (leer si existen):**
7. `.discipline/packets/STEP_4_EXECUTION_PACKET.md` — para verificar flujos esperados
8. `.discipline/packets/UI_HANDOFF_PACKET.md` — para verificacion visual

### Fase 1: Pre-deploy

**Sub-fase 1A: Gates**

```bash
npm run gate
```

Si AI_FEATURES=enabled:
```bash
npm run ai:smoke
```

Si algun gate falla, detenerse:
```
Gate fallido. Corrige los errores antes de deploy.
<output del gate>
```

Reportar: `✓ Pre-deploy: Gates OK`

**Sub-fase 1B: Build**

Ejecutar build segun LANE:

| LANE | Comando de build | Output esperado |
|---|---|---|
| WEB | `npm run build` | `dist/` sin errores |
| WEB_SSR | `npm run build` | `.next/` sin errores |
| MOBILE | Sin build local (EAS hace build en la nube) | N/A |
| DESKTOP | `npm run tauri build` | Bundle nativo |
| BACKEND | `npm run build` (si existe) | Build sin errores |
| CLI | `npm run build` (si existe) | Build sin errores |

Si build falla, detenerse con output del error.

Reportar: `✓ Pre-deploy: Build OK`

**Sub-fase 1C: Checklist pre-deploy**

Presentar checklist segun LANE. Pedir confirmacion del operador.

Para WEB:
```
Checklist pre-deploy (Web):
- [ ] Build genera dist/ sin errores ni warnings criticos
- [ ] manifest.webmanifest tiene nombre e iconos reales (no placeholder)
- [ ] Service worker registrado en index.html o main.tsx
- [ ] Variables de entorno apuntan a produccion
- [ ] .env NO esta en el repo (verificar .gitignore)

¿Todo listo? (si/no)
```

Para MOBILE:
```
Checklist pre-deploy (Mobile):
- [ ] app.json tiene bundleIdentifier real
- [ ] eas.json configurado con perfiles preview y production
- [ ] Variables de entorno de produccion configuradas en EAS secrets
- [ ] Iconos y splash screen reales (no placeholder)

¿Todo listo? (si/no)
```

Para BACKEND:
```
Checklist pre-deploy (Backend / Services):
- [ ] Dockerfile valido (si aplica)
- [ ] GET /health responde 200
- [ ] Variables de entorno de produccion configuradas en el hosting
- [ ] CORS configurado con origins explicitos (no *)

¿Todo listo? (si/no)
```

Para WEB_SSR:
```
Checklist pre-deploy (Web SSR):
- [ ] Build genera .next/ sin errores
- [ ] Metadata (title, description) actualizados
- [ ] Variables de entorno configuradas en Vercel/hosting
- [ ] API routes responden correctamente

¿Todo listo? (si/no)
```

Para DESKTOP y CLI: adaptar segun su deploy target.

No continuar si el operador dice "no". Preguntar que falta.

### Fase 2: Deploy

**Determinar comando de deploy.** Basandose en LANE y HOSTING de discipline.md:

| LANE | HOSTING | Comando |
|---|---|---|
| WEB | Vercel | `npx vercel --prod` |
| WEB | Cloudflare | `npx wrangler pages deploy dist` |
| WEB | Netlify | `npx netlify deploy --prod --dir=dist` |
| WEB_SSR | Vercel | `npx vercel --prod` |
| WEB_SSR | Cloudflare | `npx wrangler pages deploy .next` |
| MOBILE | EAS | `eas build --profile production --platform all` |
| DESKTOP | GitHub Releases | `npm run tauri build` + upload binaries (ver receta 36e) |
| EXTENSION | Chrome Web Store + Firefox AMO | `npm run zip` → upload `.output/*-chrome.zip` a CWS ($5 one-time) + `.output/*-firefox.zip` a AMO (gratis). Review 1-5 dias primera vez. Ver receta 36 para Extension. |
| BACKEND | Railway | `railway up` (default MVP; $5/mes hobby plan) |
| BACKEND | Fly.io | `fly deploy` (solo edge multi-region con presupuesto; sin free tier desde 2024) |
| CLI | npm | `npm publish` |
| CLI | PyPI | `python -m twine upload dist/*` |

**Pedir confirmacion antes de ejecutar:**

```
Voy a ejecutar el deploy:
> <comando>

¿Proceder? (si/no)
```

Ejecutar solo si el operador confirma. Si dice "no", preguntar que prefiere hacer.

Reportar resultado del deploy (exito o error con output).

**Sub-fase 2B: Verificacion post-deploy**

Si Playwright MCP esta disponible y LANE tiene UI (WEB, MOBILE con webview, WEB_SSR, DESKTOP):

Ejecutar verificacion automatizada. El prompt para Playwright depende del LANE:

Para WEB:
```
Usa Playwright MCP para navegar a [URL de produccion].
Verifica en orden:
1. La pagina carga sin errores de consola
2. Login funciona end-to-end (si AUTH_MODE != NONE)
3. La accion core del MVP se completa
4. Navegar a una ruta directa no da 404 (SPA routing)
5. El estado empty se muestra correctamente
```

Para WEB_SSR:
```
Usa Playwright MCP para navegar a [URL].
Verifica en orden:
1. La pagina inicial carga con contenido SSR visible
2. No hay errores de hidratacion en consola
3. Login funciona end-to-end (si aplica)
4. La accion core del MVP se completa
5. /api/health responde 200
```

Si Playwright no esta disponible, reportar:
```
Playwright MCP no disponible. Verificacion manual recomendada.
```

Reportar resultados de verificacion.

### Fase 3: Capturar feedback

Hacer estas preguntas al operador:

```
Feedback post-deploy:

1. ¿El flujo principal funciono end-to-end? (login → accion core → resultado)
2. ¿Encontraste algun problema? (bugs, errores, flujos rotos)
3. ¿Hubo fricciones de UX? (confuso, lento, feo)
4. ¿Surgieron ideas nuevas de features desde el uso real?
5. ¿Preocupaciones de arquitectura? (performance, seguridad, datos)
6. ¿Que deberia pasar ahora? (mas slices / fix bugs / ir a producto)
```

Esperar respuestas del operador.

### Fase 4: Generar outputs

**POST_DEPLOY_FEEDBACK_PACKET:**

```markdown
# POST_DEPLOY_FEEDBACK_PACKET

STATUS: ready
SOURCE_STEP: Paso 6
GENERATED: <fecha>
DEPLOY_TYPE: <preview | production>
DEPLOY_TARGET: <URL o destino>

## Deploy summary
- Lane: <LANE>
- Hosting: <HOSTING>
- Gates: passed
- Build: clean
- Playwright verification: <passed / skipped / issues found>

## Main flow status
<respuesta a pregunta 1>

## Issues found
<respuesta a pregunta 2, estructurada por severidad>

## UX frictions
<respuesta a pregunta 3>

## Feature ideas
<respuesta a pregunta 4>

## Architecture concerns
<respuesta a pregunta 5>

## Recommended branch
<basado en respuesta 6:>
- Si "mas slices" o "fix bugs": Paso 4 feedback loop
- Si "ir a producto": Paso 7 productizacion
```

Guardar en: `.discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md`

**Patch blocks (solo si el feedback cambia backlog o findings):**

Si hay issues, features nuevas o riesgos nuevos:
- `TASK_PLAN_PATCH_BLOCK`: agregar items nuevos al backlog
- `FINDINGS_APPEND_BLOCK`: documentar fricciones, riesgos, decisiones

Guardar en: `.discipline/patches/pending/`

### Fase 5: Post-procesamiento

Aplicar patches si se generaron:
```bash
npm run discipline:patch
```

Determinar siguiente paso basandose en el "Recommended branch" del packet:

Si es "Paso 4 feedback loop":
```bash
npm run discipline:assemble -- --step 4-feedback
```

Si es "Paso 7 productizacion":
```bash
npm run discipline:assemble -- --step 7
```

Registrar en run-log:
```bash
npm run discipline:log -- --step 6 --tool "Claude" --notes "Automated via /discipline-step6. Deploy: <tipo>. Issues: <N>."
```

### Fase 6: Resumen

Mostrar al usuario:

```
Paso 6 completado.

Deploy: <tipo> a <destino>
Gates: passed
Build: clean
Verificacion: <Playwright passed / manual>

Feedback capturado:
- Issues: <N>
- Features nuevas: <N>
- Fricciones: <N>

Archivos generados:
- .discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md
<si aplica:>
- Patch blocks aplicados: <N>

Siguiente paso:
<segun branch recomendado>
- /discipline-step4 (feedback loop) → .discipline/paste-ready/paso-4-feedback.md
- /discipline-step7 (productizacion) → .discipline/paste-ready/paso-7-input.md
```

---

## Manejo de errores

- Si `DEPLOY_READINESS_PACKET` no existe: detenerse con "Completa los slices en Paso 5 primero."
- Si gates fallan: detenerse. No deployar con gates rotos.
- Si build falla: detenerse. Reportar output del error.
- Si deploy falla: reportar error, no generar POST_DEPLOY_FEEDBACK_PACKET (no hubo deploy real).
- Si Playwright no esta disponible: saltar verificacion automatizada, continuar con feedback manual.
- Si el operador no responde todas las preguntas de feedback: generar el packet con lo disponible. Las preguntas sin respuesta se marcan como "N/A - no evaluado".
- Si `npm run discipline:patch` o `discipline:assemble` fallan: reportar error y continuar. Los archivos ya estan en `.discipline/packets/`.

---

## Reglas criticas

- No deployar sin gates pasando. Nunca. Sin excepciones.
- No deployar sin confirmacion explicita del operador. El skill propone, el operador aprueba.
- No inventar feedback. El POST_DEPLOY_FEEDBACK_PACKET refleja lo que el operador dijo, no lo que Claude infiere.
- No asumir el "recommended branch". Preguntar al operador que quiere hacer despues.
- Playwright MCP es complementario, no sustituto de verificacion humana.
- Los comandos de deploy dependen del LANE y HOSTING. Leer ambos de discipline.md, no asumir.
- Si es el primer deploy del proyecto, incluir verificacion de platform skeleton (manifest, icons, etc.).
- Registrar TODO en el run-log, incluyendo tipo de deploy, issues encontrados y branch siguiente.
