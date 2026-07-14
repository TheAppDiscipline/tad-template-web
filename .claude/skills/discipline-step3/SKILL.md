---
name: discipline-step3
description: "Automate Discipline Loop Step 3: prepare context for Stitch, orchestrate UI generation via Stitch MCP or a manual Stitch session, and produce the UI_HANDOFF_PACKET. Triggers on /discipline-step3, 'run step 3', 'generate the UI', or 'do the Stitch handoff'."
---

# /discipline-step3 - Automate Step 3 of the Discipline Loop pipeline

This skill prepares the context for Stitch, orchestrates screen generation (via Stitch MCP if it is available, or by guiding the operator on stitch.withgoogle.com), and produces the UI_HANDOFF_PACKET from whatever Stitch generated.

**Stitch is the primary tool for this step.** The skill does not replace Stitch; it complements it by handling the before (prepare context) and the after (assemble the packet and paste-readies).

## What the user sees

1. The skill verifies that the LANE has a UI (not BACKEND or CLI)
2. It prepares the prompt optimized for Stitch with per-lane adaptations
3. If Stitch MCP is available: it generates screens automatically
4. If not: it guides the operator to use stitch.withgoogle.com and report the results
5. It assembles the UI_HANDOFF_PACKET from Stitch's output
6. It assembles paste-readies and reports the next step

## Prerequisites

- Step 1 completed (packets in `.discipline/packets/`)
- Step 2 completed (`STEP_4_EXECUTION_PACKET.md` with STATUS: validated)
- `STEP_3_STITCH_PACKET.md` must exist in `.discipline/packets/`
- Node.js + npm (to run the Discipline Loop scripts)
- **Primary tool: Google Stitch** (stitch.withgoogle.com, free, 350 gen/month)
- **Stitch does not expose an official installable MCP server:** its handoff is manual (export from stitch.withgoogle.com and paste the result). If your environment already has a Stitch MCP configured, the skill detects it and uses it; if not, it operates in guided mode.

---

## Internal implementation

### Phase 0: Verify inputs and LANE

**Verify LANE.** Read `discipline.md` and extract the value of LANE.

If LANE is BACKEND or CLI:
```
LANE={lane} has no UI. Step 3 does not apply. Go to Step 4: /discipline-step4
```
Stop.

**Verify inputs:**

**Required (one of the two):**
1. `.discipline/paste-ready/step-3-input.md` (preferred, already assembled)
2. `.discipline/packets/STEP_3_STITCH_PACKET.md` (direct source)

If neither exists:
```
The STEP_3_STITCH_PACKET is missing. Run /discipline-step1 first.
```

**Project context (always read):**
3. `discipline.md` — switches, contracts, rules
4. `.discipline/packets/STEP_4_EXECUTION_PACKET.md` — validated architecture, slices, data contracts
5. `task_plan.md`
6. `findings.md`

**Optional (read if they exist):**
7. `.discipline/step1-outputs/06_UI_States.md` — UI states from Step 1
8. `.discipline/step1-outputs/04_User_Stories.md` — user stories to understand flows
9. `.discipline/packets/AI_IMPLEMENTATION_PACKET.md` — if there are AI features that affect the UI

**Detect Stitch MCP.** Check whether the Stitch MCP is available:
- Look for `stitch` in the list of configured MCPs
- If available: automatic mode (Phase 1A)
- If not: guided mode (Phase 1B)

### Phase 1A: Generation with Stitch MCP (if available)

If Stitch MCP is configured, use it directly.

**Prepare the prompt for Stitch.** Build the prompt including:

1. App name and description (from discipline.md)
2. P0 screens listed in the STITCH_PACKET
3. Main user flows
4. Per-LANE adaptations:

For WEB:
```
Context: responsive web app (mobile-first).
Patterns: top nav or sidebar, responsive breakpoints, PWA install prompt.
```

For MOBILE:
```
Context: native mobile app (iOS/Android).
Patterns: bottom tabs if there are sections, stack navigation, safe areas, haptic feedback.
```

For DESKTOP:
```
Context: desktop app (Mac/Windows/Linux).
Patterns: window chrome, sidebar, menu bar, drag areas.
```

For WEB_SSR:
```
Context: web app with SSR (Next.js).
Patterns: same as web, but consider that the first render comes from the server.
```

**Prompt construction gotchas** (observed in real runs; they apply to Phase 1A and 1B alike):

- **State the app name explicitly and defend it.** If the prompt describes the *feeling* of the design with a noun ("calm", "serenity", "trust"), Stitch tends to adopt that noun as the **brand name** and stamps it on every screen header. Always include: `The app is called "<NAME>". Words describing the intended feeling are NOT the name.` If the name drifts, correct it **immediately** — otherwise it propagates to every screen generated afterwards.
- **Ask for states in the prompt text, not with the "multiple variants" toggle.** That toggle produces alternative *visual styles* of one screen (an exploration tool). It does NOT produce the normal/loading/empty/error **states** this step needs, and using it after the design system is fixed breaks visual consistency across screens.
- **Lock the design system in the first prompt**, then generate every remaining screen in the **same project/thread** so they inherit it.
- **Generate only the states that are visually distinctive** (screens whose empty/error/special state differs structurally from normal). Trivial loading/empty/error states are cheaper to document from the contracts in Phase 2 than to generate.

**Call the MCP.** Use the Stitch tools:
- `stitch_generate_screens` with the prepared prompt
- `stitch_get_design_system` to read the generated design system
- `stitch_get_screens` to read the generated screens

**Verify the result.** For each P0 screen:
- Verify that it exists in Stitch's output
- Verify that it covers the 4 states (normal, loading, empty, error) or document which ones are missing

Report: `✓ Stitch generated <N> screens via MCP`

Go to Phase 2.

### Phase 1B: Guided generation (if Stitch MCP is not available)

If Stitch MCP is not available, guide the operator.

**Prepare the prompt optimized for Stitch.** Same content as Phase 1A, but formatted for copy and paste.

Show to the operator:

```
Stitch MCP is not available. Use Stitch manually:

1. Create a NEW project at stitch.withgoogle.com (do not reuse an existing one)
2. Set the target: the composer has an "App" / "Web" toggle and DEFAULTS TO "App"
   (native mobile). For LANE=WEB or WEB_SSR you MUST switch it to "Web", or Stitch
   generates iOS/Android native patterns that do not apply. Leave it on "App" only
   for LANE=MOBILE.
3. Paste this master prompt (design direction + first screen):

---
<prompt prepared with app name, P0 screens, flows, per-LANE adaptations>
---

4. Paste the remaining per-screen prompts one at a time, IN THE SAME PROJECT, so they
   inherit the design system
5. Use the Play button to navigate the flow
6. Export: choose ".zip". It downloads the code locally with no third party involved.
   Do NOT pick "AI Studio" — that submits the content to Google AI Studio's terms.
   The export caps at ~16 screens per download; if you generated more, either
   deselect the least structural screens (plain empty/error states) or run a second
   export. Superseded duplicates of a screen should NOT be exported: two conflicting
   versions of the same screen in the repo will confuse Step 5.
7. Save the export under `design/stitch-export/` in the repo and EXTRACT it (a zipped
   binary is unreadable to Step 5 and to any cloud agent in the GitHub lane)
8. When you are done, tell me:
   - How many screens were generated?
   - Do they cover the main flows?
   - Is there anything Stitch could not generate well?
```

Wait for the operator's response. If they report problems with any screen, document it in findings.md.

Report: `✓ Operator completed Stitch manually: <N> screens`

### Phase 2: Assemble the UI_HANDOFF_PACKET

**If Stitch MCP was used:** read the generated screens via `stitch_get_screens` and the design system via `stitch_get_design_system`.

**If Stitch was used manually:** ask the operator to briefly describe each generated screen, or to paste the URL of the Stitch session.

**For each P0 screen, document the 4 states:**

These are mandatory. If Stitch did not generate one explicitly, infer it from the normal screen and the project contracts:

1. **normal** — layout, components, primary action, secondary actions, per-role variants
2. **loading** — skeleton/spinner, what is already visible vs what is waiting on data
3. **empty** — action-oriented message, suggested illustration, distinguish "new" vs "no results"
4. **error** — user-friendly message, recovery action, error boundaries

**Apply per-LANE adaptations** (mandatory):
- WEB: responsive notes, PWA considerations
- MOBILE: safe areas, navigation patterns, gestures
- DESKTOP: window chrome, IPC boundaries, menu bar
- WEB_SSR: SSR vs client rendering, hydration boundaries

**Assemble the packet.** Canonical format:

```markdown
# UI_HANDOFF_PACKET

LANE: <lane>
SCREENS: <N total>
GENERATED: <date>
SOURCE: Stitch <MCP | manual>

---

## SCREEN: <name>

### States

#### normal
- Structure: <layout>
- Main components: <list>
- Primary action: <CTA>
- Notes for implementation: <hints>

#### loading
...

#### empty
...

#### error
...

---

## Flow Notes

### Navigation Map
<how the screens connect>

### Shared Components
<components that repeat>

### Interaction Patterns
<per-LANE patterns>

### Accessibility Notes
<labels, contrast, focus, screen reader>
```

Save to: `.discipline/packets/UI_HANDOFF_PACKET.md`
Report: `✓ UI_HANDOFF_PACKET assembled with <N> screens`

**Handle the Stitch export.** The `.zip` extracts to one folder per screen containing `code.html` and `screen.png`, plus a `<project>/DESIGN.md`. Three rules:

1. **Read `DESIGN.md`. Never infer design tokens from screenshots.** Stitch ALWAYS emits a `DESIGN.md` in the export with the authoritative token set (Material-3-style color roles, typographic scale, radii, spacing, layout, component guidance). Eyeballing hex values off a swatch image gets them **wrong** — swatch tiles show container/variant shades, not the base role, so the `primary` you read from the image is typically the `primary-container`. Open the file.
2. **Write a `README.md` in `design/stitch-export/`** stating that the export is **reference, not source**: do not copy the mockup HTML into `src/`, it bypasses the backend adapter, the semantic-token rule, and the `limit` rule. The contract for Step 5 is the UI_HANDOFF_PACKET, not the mockups.
3. **Warn about hotlinked assets.** Stitch mockups reference AI-generated avatars/illustrations from Google's CDN (`lh3.googleusercontent.com/...`). Harmless in a mockup; in production it is a privacy leak to a third party and a link that will rot. The README must say: use your own assets.

**Generate a DESIGN_MD_READY_BLOCK** whenever a `DESIGN.md` exists in the export (with Stitch, it always does). Transcribe the real token set from that file — colors, typography, radii, spacing, layout — and frame the hex values as **brand values that populate semantic tokens** in Step 5, never as raw hex for components (`discipline.md §8` forbids raw hex; the `check-tokens` gate enforces it).

**Flag the dark-theme gap.** Stitch emits a **light-mode token set only**, while `discipline.md §8` requires light **and** dark. This mismatch is systematic, not project-specific. Record it as an explicit gap in the DESIGN_MD_READY_BLOCK so Step 5 derives the dark palette instead of assuming §8 is satisfied.

### Phase 3: Post-processing

Assemble the paste-ready for Step 4:
```bash
npm run discipline:assemble -- --step 4
```

Log to the run-log:
```bash
npm run discipline:log -- --step 3 --tool "Stitch <MCP|manual> + Claude" --notes "Automated via /discipline-step3"
```

### Phase 4: Summary and next step

```
Step 3 completed.

Tool: Stitch <MCP | manual>
Screens documented: <N>
<list of screen names>

Files generated:
- .discipline/packets/UI_HANDOFF_PACKET.md
<if generated:>
- .discipline/packets/DESIGN_MD_READY_BLOCK.md

Paste-readies updated:
- .discipline/paste-ready/step-4-input.md

Next step: /discipline-step4 (Executable slices)
```

---

## Error handling

- If LANE is BACKEND or CLI: stop immediately. This is not an error, it is an expected skip.
- If STEP_3_STITCH_PACKET does not exist: stop with "Run /discipline-step1 first."
- If Stitch MCP fails: fall back to guided mode (Phase 1B). Report the MCP error.
- If Stitch cannot generate some screen: document it in the UI_HANDOFF_PACKET with "TODO: requires manual generation" and log it in findings.md.
- If the operator reports that Stitch did not cover a flow: document it as a gap and include it in the handoff so that Step 5 resolves it during implementation.
- If `npm run discipline:assemble` fails: report it. The UI_HANDOFF_PACKET is already in `.discipline/packets/`.
- If `npm run discipline:log` fails: report it but do not block.

---

## Critical rules

- **Stitch is the primary tool.** Do not generate screens with Claude. Claude assembles the packet from what Stitch produced.
- If Stitch MCP is available, use it. If not, guide the operator. In both cases, Stitch generates the screens.
- The 4 states (normal, loading, empty, error) are mandatory per screen. If Stitch did not generate them all, complete the state documentation from the normal screen and the project contracts.
- The per-LANE adaptations are mandatory. A WEB screen must include responsive notes; a MOBILE screen must include safe areas.
- Do not invent screens that are not in the STITCH_PACKET. Only document the P0 screens listed.
- Do not recommend component libraries unless discipline.md or the STITCH_PACKET mentions them.
- The implementation notes are hints, not code. The code is written in Step 5.
- If there are inconsistencies between Stitch and the STEP_4_EXECUTION_PACKET (e.g., a screen references data that is not in the contracts), document it in findings.md and use the contracts as the source of truth.
- **Set the Stitch target to "Web" for LANE=WEB/WEB_SSR.** The composer defaults to "App" (native mobile); leaving it there produces iOS/Android patterns that do not apply.
- **Design tokens come from the export's `DESIGN.md`, never from screenshots.** Reading hex off a swatch image yields the container shade, not the base role.
- **The export is reference, not source.** It ships with a README saying so, and never gets copied into `src/`. Its hotlinked CDN images never reach production.
- **Stitch only emits light-mode tokens.** `discipline.md §8` demands light and dark: record the dark-theme gap explicitly rather than letting Step 5 assume §8 is met.
- **Verify the contract-critical states against `discipline.md`, not against how good the screen looks.** A state that must show *no value* (an uncomputable metric, a blocked suggestion) must show no value — not a placeholder zero. Generators reach for `0` by default; that is a contract violation, and it is the single most likely thing to slip through this step.
