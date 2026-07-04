---
name: discipline-legal-init
description: "Generate legal docs (privacy-policy.md, terms-of-service.md, refund-policy.md, breach-runbook.md) populated with real project data from discipline.md, package.json vendors, and detected imports. Output is a starting point, NOT legal advice. Triggers on /discipline-legal-init, 'legal init', 'privacy terms', 'generate privacy policy'."
---

# /discipline-legal-init - Generate as-built legal documents for the project

This skill takes the 4 legal templates from the vault (a Legal Templates folder in The App Discipline vault, sold separately) and customizes them with real project data: vendors detected in `package.json` plus imports in `src/`, retention for each vendor, the current profile, and the support contact email. It produces a starting point ready to review and publish.

CRITICAL: the output is NOT legal advice. It is an as-built baseline. For serious commercial production, validate with local counsel in the applicable jurisdiction.

## What the user sees

1. The skill confirms key data (APP_NAME, COMPANY_OR_NAME, JURISDICTION, CONTACT_EMAIL, APP_URL).
2. It detects vendors used in the project (Supabase, Sentry, Stripe, Resend, PostHog, Anthropic, etc.).
3. It asks which documents to generate (privacy-policy required; terms-of-service required; refund-policy if you charge money; breach-runbook recommended).
4. It generates the files in `public/legal/` (public) and `runbooks/breach.md` (internal).
5. It reports the placeholders it could NOT resolve automatically and leaves them for the user to complete.
6. It suggests running `/discipline-audit privacy-policy` (audit 3) afterward to verify that policy and code stay consistent.

## Prerequisites

- Repo with `.discipline/` and `discipline.md`.
- Readable `package.json` with dependencies and devDependencies.
- Access to the Discipline Loop vault (the templates live in a Legal Templates folder in the vault, sold separately, not in the repo).
- If the templates have not been copied into the repo, the skill asks the user for them once (manual paste from the vault).

---

## Internal implementation

### Phase 0: Verify preconditions

Read `discipline.md`. Extract PROFILE. If LITE with no external services, warn:

```
PROFILE=LITE with no external services. Legal documents are NOT required for personal use.

If you plan to move to FAMILY_SYNC or LAUNCH:
- Privacy Policy + ToS are required for Gate D Launch.
- Refund Policy is required if you charge money.
- Breach Runbook is recommended from the first piece of external data.

Generate the templates anyway as preparation? (Y/N)
```

If the user says N, stop.

### Phase 1: Collect project data

Detect and confirm with the user:

| Placeholder | How it is detected | Default if missing |
|---|---|---|
| `{{APP_NAME}}` | `discipline.md §0` (APP_NAME field or title) or `package.json` name | ask |
| `{{COMPANY_OR_NAME}}` | `discipline.md` or git config user.name | ask |
| `{{CONTACT_EMAIL}}` | `discipline.md` SUPPORT_EMAIL field or git config user.email | ask |
| `{{JURISDICTION}}` | always ask (cannot be detected) | ask |
| `{{LAST_UPDATED}}` | current date ISO (YYYY-MM-DD) | auto |
| `{{APP_URL}}` | discipline.md APP_URL field or package.json homepage | ask |
| `{{REFUND_WINDOW_DAYS}}` | discipline.md or default 30 | 30 |

Show the table and ask the user to confirm before continuing.

### Phase 2: Detect vendors

Grep imports in `src/**/*.{ts,tsx,js,jsx}` and `package.json`. Map each import to a canonical vendor:

| Pattern | Canonical vendor | Category | Default retention |
|---|---|---|---|
| `@supabase/*` | Supabase (Database, Auth) | Backend | "as long as the account is active" |
| `@sentry/*` | Sentry | Error monitoring | "90 days by default" |
| `posthog-js` | PostHog | Analytics | "per plan, typically 7-90 days" |
| `resend` | Resend | Email transactional | "30 days for send logs" |
| `@anthropic-ai/sdk` | Anthropic Claude API | LLM | "no training by default, 30 days log retention if abuse detected" |
| `openai` | OpenAI | LLM | "30 days log retention unless opted out" |
| `@google/genai` | Google AI Studio / Gemini | LLM | "per plan, free tier may use data for training unless opted out" |
| `stripe` | Stripe | Payments | "per Stripe policy; tokenized cards not on your server" |
| `firebase`, `firebase-admin` | Firebase | Backend | "as long as the account is active" |
| `@vercel/*`, `@cloudflare/*` | Hosting CDN | Infra | "logs typically 30-90 days" |

For each detected vendor, capture:
- name
- purpose (category)
- declared retention (best estimate)
- vendor jurisdiction (US, EU, etc., for the transfer mechanism)

### Phase 3: Confirm the vendor list with the user

```
Vendors detected in code:
- Supabase (Database, Auth) - retention: as long as account active - US (DPF)
- Sentry (Error monitoring) - retention: 90 days - US (SCCs)
- Resend (Email) - retention: 30 days logs - US (SCCs)

Any missing vendor? Some common ones the grep does not detect:
- Cloudflare Pages / Vercel (hosting)
- Google Analytics (if you added it manually with a tag)
- Plausible / Fathom (privacy-first analytics)
- Crisp / Intercom (chat)
- Cal.com / Calendly (booking)

List the missing vendors (comma separated) or "none":
```

### Phase 4: Load templates

The templates live in `<vault>/Legal Templates/*.template`. If the user's repo does not have access to the vault, ask for a manual paste once:

```
I cannot access `<vault>/Legal Templates/`.

Options:
1. Paste the contents of `privacy-policy.md.template` here (I will save it in `.discipline/legal-templates/`).
2. Let me read from the vault's absolute path if you know it (e.g. `/Users/x/Vault/...`).
3. Exit and manually copy the templates into `public/legal/`, then customize.
```

Load the 4 templates into memory.

### Phase 5: Generate customized documents

For each requested document:

1. Read the template.
2. Substitute the `{{...}}` placeholders with the data confirmed in Phase 1.
3. For `privacy-policy.md`, complete the "Data shared with third parties" section with the vendor list from Phase 2-3, formatted:
   ```
   | Service | Purpose | Data shared | Retention | Jurisdiction/Transfer |
   |---|---|---|---|---|
   | Supabase | Database + Auth | Email, user content | As long as the account is active | US (Data Privacy Framework) |
   | ... | ... | ... | ... | ... |
   ```
4. Strike out sections that do not apply according to the project switches:
   - If there is NO `stripe`/`@stripe/*` in deps: strike the Payments section.
   - If there is NO `@anthropic-ai/sdk`/`openai`/`@google/genai`: strike the AI Usage section.
   - If there are no cookies (the template assumes there are): ask the user.
5. **Delete** the `[!warning] TEMPLATE, NOT LEGAL ADVICE` block and the HTML comment at the top of each template (they are no longer a template, they are real docs).
6. Add a version entry and internal changelog at the end:
   ```markdown
   ## Internal changelog
   - <date> · v1.0 generated via /discipline-legal-init with vendors: <list>.
   ```

### Phase 6: Write files

Suggested structure (ask the user if they prefer another):

```
<repo>/
├── public/legal/
│   ├── privacy-policy.md
│   ├── terms-of-service.md
│   └── refund-policy.md (only if you charge money)
└── runbooks/
    └── breach.md (NOT public; .gitignore-able if it holds sensitive contacts)
```

Verify that the paths exist, create directories if they do not.

If the files already exist, do NOT overwrite without confirmation. Show a diff and ask for approval.

### Phase 7: Post-generation verification

Ask the user to:
1. Serve each file at the route the template expects (`/privacy`, `/terms`, `/refund`).
2. Link them from the footer + signup + Settings.
3. Run `/discipline-audit privacy-policy` (audit 3 of the self-audit prompts in the vault, sold separately) to verify that the policy reflects the real app.
4. Mark items L01 (Privacy Policy) and L02 (ToS) in `.discipline/scorecard.yaml` with evidence.

### Phase 8: Summary

```
Legal documents generated:

✓ public/legal/privacy-policy.md (Vendors: <list>)
✓ public/legal/terms-of-service.md
<if refund:>
✓ public/legal/refund-policy.md (window: <N> days)
✓ runbooks/breach.md (internal; fill in the DPA and counsel contacts BEFORE you need them)

Placeholders not resolved automatically (review before publishing):
- <list>

Recommended actions:
1. Serve the files at /privacy, /terms, /refund of your app.
2. Link them from the footer + signup + Settings.
3. Run `/discipline-audit privacy-policy` to verify consistency with the code.
4. For serious commercial production, validate with local counsel in your jurisdiction.

CRITICAL: these documents are an as-built starting point, NOT legal advice. The Discipline Loop doctrine is: the vault gives you a base; the lawyer tailors it to your real case.
```

Log in `findings.md §Legal`:
```markdown
## Legal

- <date> · /discipline-legal-init generated privacy-policy.md + terms-of-service.md + refund-policy.md + runbooks/breach.md. Vendors detected: <list>. Pending placeholders: <list>. Verify with local counsel before Gate E PROD.
```

---

## Error handling

- Templates not accessible: ask for a manual paste or exit with instructions to copy them manually.
- Vendors detected in conflict (e.g. both `firebase` and `@supabase/supabase-js`): ask the user which one is primary.
- Discipline.md does not declare APP_URL: ask and persist the value in discipline.md via a patch block (optional, with the user's approval).
- Destination file already exists: do not overwrite without a visible diff and approval.
- If the user charges money but does not generate a refund-policy: warn and log it in findings.md §Legal as debt.

---

## Critical rules

- **Output is NOT legal advice.** Report this explicitly at the end of the run, no exceptions.
- The Privacy Policy must be **as-built**: if the app does not use Stripe, do not mention Stripe.
- Do not invent vendors that are not in the code. The "mention everything just in case" rule does not apply; mention what you detected.
- Do not copy the refund policy text from the Discipline Loop vault without adjustment; the vault uses 30 days no questions asked, but the user's app may have a different policy.
- The breach runbook is NOT public; verify that it is in `runbooks/` or equivalent, NOT in `public/`.
- When the jurisdiction is EU: add a note about the 14-day right of withdrawal and GDPR Art. 33 compliance (72h breach notification).
- Do not mark scorecard items L01/L02 as `done` automatically. The user verifies that the files are published AND reflect the real app, then records evidence.
- Target time: 5-10 min to generate the 4 docs in a project with typical vendors.
