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

1. Open stitch.withgoogle.com
2. Copy and paste this prompt:

---
<prompt prepared with app name, P0 screens, flows, per-LANE adaptations>
---

3. Generate the P0 screens
4. Use the Play button to navigate the flow
5. Export the code (React + Tailwind recommended for Web)
6. When you are done, tell me:
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

**Optionally, generate a DESIGN_MD_READY_BLOCK** if Stitch produced design decisions (colors, typography, spacing) that should persist. Only if there is real content, not by default.

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
