---
name: discipline-legal-init
description: "Generate legal docs (privacy-policy.md, terms-of-service.md, refund-policy.md, breach-runbook.md) populated with real project data from discipline.md, package.json vendors, and detected imports. Output is a starting point, NOT legal advice. Triggers on /discipline-legal-init, 'init legal', 'generar privacy policy'."
---

# /discipline-legal-init - Generar documentos legales as-built del proyecto

Este skill toma las 4 plantillas legales del vault (`Plantillas/Plantillas Legales/`) y las personaliza con datos reales del proyecto: vendors detectados en `package.json` + imports de `src/`, retention de cada vendor, profile actual, contact email de soporte. Produce un punto de arranque listo para revisar y publicar.

CRÍTICO: el output NO es asesoría legal. Es un baseline as-built. Para producción comercial seria, validar con counsel local de jurisdicción aplicable.

## Lo que el usuario ve

1. El skill confirma datos clave (APP_NAME, COMPANY_OR_NAME, JURISDICTION, CONTACT_EMAIL, APP_URL).
2. Detecta vendors usados en el proyecto (Supabase, Sentry, Stripe, Resend, PostHog, Anthropic, etc.).
3. Pregunta cuáles documentos generar (privacy-policy obligatorio; terms-of-service obligatorio; refund-policy si cobras; breach-runbook recomendado).
4. Genera los archivos en `public/legal/` (público) y `runbooks/breach.md` (interno).
5. Reporta los placeholders que NO pudo resolver automáticamente y deja al usuario completarlos.
6. Sugiere correr `/discipline-audit privacy-policy` (audit 3) después para verificar coherencia policy ↔ código.

## Prerrequisitos

- Repo con `.discipline/` y `discipline.md`.
- `package.json` legible con dependencies y devDependencies.
- Acceso al vault Discipline Loop (las plantillas viven en `Plantillas/Plantillas Legales/` del vault, no del repo).
- Si las plantillas no están copiadas al repo, el skill las solicita al usuario una vez (paste manual desde el vault).

---

## Implementacion interna

### Fase 0: Verificar precondiciones

Leer `discipline.md`. Extraer PROFILE. Si LITE sin externos, advertir:

```
PROFILE=LITE sin externos. Los documentos legales NO son obligatorios para uso personal.

Si planeas pasar a FAMILY_SYNC o LAUNCH:
- Privacy Policy + ToS son obligatorios para Gate D Launch.
- Refund Policy obligatoria si cobras.
- Breach Runbook recomendado desde primer dato externo.

¿Generar las plantillas igualmente como preparación? (Y/N)
```

Si el usuario dice N, terminar.

### Fase 1: Recoger datos del proyecto

Detectar y confirmar con el usuario:

| Placeholder | Cómo se detecta | Default si falta |
|---|---|---|
| `{{APP_NAME}}` | `discipline.md §0` (campo APP_NAME o título) o `package.json` name | preguntar |
| `{{COMPANY_OR_NAME}}` | `discipline.md` o git config user.name | preguntar |
| `{{CONTACT_EMAIL}}` | `discipline.md` campo SUPPORT_EMAIL o git config user.email | preguntar |
| `{{JURISDICTION}}` | preguntar siempre (no se puede detectar) | preguntar |
| `{{LAST_UPDATED}}` | fecha actual ISO (YYYY-MM-DD) | auto |
| `{{APP_URL}}` | discipline.md campo APP_URL o package.json homepage | preguntar |
| `{{REFUND_WINDOW_DAYS}}` | discipline.md o default 30 | 30 |

Mostrar tabla y pedir confirmación del usuario antes de continuar.

### Fase 2: Detectar vendors

Grep imports en `src/**/*.{ts,tsx,js,jsx}` y `package.json`. Mapear cada import a vendor canónico:

| Patrón | Vendor canónico | Categoría | Retention default |
|---|---|---|---|
| `@supabase/*` | Supabase (Database, Auth) | Backend | "mientras la cuenta esté activa" |
| `@sentry/*` | Sentry | Error monitoring | "90 días por defecto" |
| `posthog-js` | PostHog | Analytics | "según plan, típicamente 7-90 días" |
| `resend` | Resend | Email transactional | "30 días los logs de envío" |
| `@anthropic-ai/sdk` | Anthropic Claude API | LLM | "no entrenamiento por defecto, 30 días retention de logs si abuse detected" |
| `openai` | OpenAI | LLM | "30 días retention de logs si no opt-out" |
| `@google/genai` | Google AI Studio / Gemini | LLM | "según plan, free tier puede usar para training salvo opt-out" |
| `stripe` | Stripe | Payments | "según política de Stripe; tarjetas tokenizadas no en server" |
| `firebase`, `firebase-admin` | Firebase | Backend | "mientras la cuenta esté activa" |
| `@vercel/*`, `@cloudflare/*` | Hosting CDN | Infra | "logs típicamente 30-90 días" |

Para cada vendor detectado, capturar:
- nombre
- propósito (categoría)
- retention declarado (mejor estimación)
- jurisdicción del vendor (US, EU, etc., para transfer mechanism)

### Fase 3: Confirmar lista de vendors con el usuario

```
Vendors detectados en código:
- Supabase (Database, Auth) — retention: mientras cuenta activa — US (DPF)
- Sentry (Error monitoring) — retention: 90 días — US (SCCs)
- Resend (Email) — retention: 30 días logs — US (SCCs)

¿Algún vendor faltante? Algunos comunes que el grep no detecta:
- Cloudflare Pages / Vercel (hosting)
- Google Analytics (si lo añadiste manualmente con tag)
- Plausible / Fathom (analytics privacy-first)
- Crisp / Intercom (chat)
- Cal.com / Calendly (booking)

Lista vendors faltantes (separados por coma) o "ninguno":
```

### Fase 4: Cargar plantillas

Las plantillas viven en `<vault>/Plantillas/Plantillas Legales/*.template`. Si el repo del usuario no tiene acceso al vault, pedir paste manual una vez:

```
No puedo acceder a `<vault>/Plantillas/Plantillas Legales/`.

Opciones:
1. Pega el contenido de `privacy-policy.md.template` aquí (lo guardo en `.discipline/legal-templates/`).
2. Permíteme leer desde la ruta absoluta del vault si la conoces (ej: `/Users/x/Vault/...`).
3. Salir y manualmente copiar las plantillas a `public/legal/`, después customizar.
```

Cargar las 4 plantillas en memoria.

### Fase 5: Generar documentos personalizados

Para cada documento solicitado:

1. Leer plantilla.
2. Sustituir placeholders `{{...}}` con datos confirmados en Fase 1.
3. Para `privacy-policy.md`, completar §"Datos compartidos con terceros" con la lista de vendors de Fase 2-3, formateada:
   ```
   | Servicio | Propósito | Datos compartidos | Retention | Jurisdicción/Transfer |
   |---|---|---|---|---|
   | Supabase | Database + Auth | Email, contenido del usuario | Mientras la cuenta esté activa | US (Data Privacy Framework) |
   | ... | ... | ... | ... | ... |
   ```
4. Tachar secciones que no aplican según switches del proyecto:
   - Si NO hay `stripe`/`@stripe/*` en deps: tachar §Pagos.
   - Si NO hay `@anthropic-ai/sdk`/`openai`/`@google/genai`: tachar §Uso de IA.
   - Si NO hay cookies (template asume sí): preguntar al usuario.
5. **Borrar** el bloque `[!warning] PLANTILLA, NO ES ASESORÍA LEGAL` y el comentario HTML del top de cada plantilla (ya no son plantilla, son docs reales).
6. Agregar entry de versión y changelog interno al final:
   ```markdown
   ## Changelog interno
   - <fecha> · v1.0 generado vía /discipline-legal-init con vendors: <lista>.
   ```

### Fase 6: Escribir archivos

Estructura sugerida (preguntar al usuario si prefiere otra):

```
<repo>/
├── public/legal/
│   ├── privacy-policy.md
│   ├── terms-of-service.md
│   └── refund-policy.md (solo si cobras)
└── runbooks/
    └── breach.md (NO público; .gitignore-able si tiene contactos sensibles)
```

Verificar que las rutas existen, crear directorios si no.

Si los archivos ya existen, NO sobrescribir sin confirmación. Mostrar diff y pedir aprobación.

### Fase 7: Verificación post-generación

Pedir al usuario:
1. Servir cada archivo en la ruta esperada del template (`/privacy`, `/terms`, `/refund`).
2. Enlazar desde footer + signup + Settings.
3. Correr `/discipline-audit privacy-policy` (audit 3 de 48c) para verificar que la policy refleja la app real.
4. Marcar items L01 (Privacy Policy) y L02 (ToS) en `.discipline/scorecard.yaml` con evidencia.

### Fase 8: Resumen

```
Documentos legales generados:

✓ public/legal/privacy-policy.md (Vendors: <lista>)
✓ public/legal/terms-of-service.md
<si refund:>
✓ public/legal/refund-policy.md (window: <N> días)
✓ runbooks/breach.md (interno; rellena los contactos del DPA y counsel ANTES de necesitarlos)

Placeholders no resueltos automáticamente (revisa antes de publicar):
- <lista>

Acciones recomendadas:
1. Servir los archivos en /privacy, /terms, /refund de tu app.
2. Enlazar desde footer + signup + Settings.
3. Correr `/discipline-audit privacy-policy` para verificar coherencia con el código.
4. Para producción comercial seria, validar con counsel local de tu jurisdicción.

CRÍTICO: estos documentos son punto de arranque as-built, NO asesoría legal. La doctrina Discipline Loop es: el vault te da una base; el abogado ajusta a tu caso real.
```

Registrar en `findings.md §Legal`:
```markdown
## Legal

- <fecha> · /discipline-legal-init generó privacy-policy.md + terms-of-service.md + refund-policy.md + runbooks/breach.md. Vendors detectados: <lista>. Placeholder pendientes: <lista>. Verificar con counsel local antes de Gate E PROD.
```

---

## Manejo de errores

- Plantillas no accesibles: pedir paste manual o salir con instrucción de copiar manualmente.
- Vendors detectados con conflicto (eg ambos `firebase` y `@supabase/supabase-js`): preguntar al usuario cuál es el primario.
- Discipline.md no declara APP_URL: preguntar y persistir el valor en discipline.md vía patch block (opcional, con aprobación del usuario).
- Archivo destino ya existe: no sobrescribir sin diff visible y aprobación.
- Si usuario cobra pero no genera refund-policy: warning y registrar en findings.md §Legal como deuda.

---

## Reglas críticas

- **Output NO es asesoría legal.** Reportar esto explícitamente al final del run, sin excepciones.
- Privacy Policy debe ser **as-built**: si la app no usa Stripe, no mencionar Stripe.
- No inventar vendors que no están en el código. La regla "menciono todo por si acaso" no aplica; menciona lo que detectaste.
- No copiar texto del refund policy del vault Discipline Loop sin ajuste; el vault tiene 30 días sin preguntas pero la app del usuario puede tener política distinta.
- Breach runbook NO es público; verificar que está en `runbooks/` o equivalente, NO en `public/`.
- Cuando jurisdicción es EU: agregar nota sobre derecho de retiro 14 días y cumplimiento GDPR Art. 33 (72h breach notification).
- No marcar items L01/L02 del scorecard como `done` automáticamente. El usuario verifica que los archivos están publicados Y reflejan la app real, después marca evidencia.
- Tiempo objetivo: 5-10 min para generar los 4 docs en proyecto con vendors típicos.
