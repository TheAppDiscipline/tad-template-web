---
name: discipline-step0a
description: "Automate Discipline Loop Step 0a: validate an app idea with REAL web-search competitor research (not invented), a structured viability evaluation, and an evidence-backed GO/NO-GO decision. Triggers on /discipline-step0a, 'validate idea', 'idea packet', or 'is this idea worth building'."
---

# /discipline-step0a - Automate Step 0a of the Discipline Loop pipeline

This skill runs the complete Step 0a: it evaluates the app idea with real market research, competitor analysis, a structured evaluation, and a GO/NO-GO decision. If the result is GO, it produces the IDEA_VALIDATION_PACKET to feed into Step 1.

It uses WebSearch for real market research. It does not require any other external tools.

## What the user sees

1. The skill asks the user to describe their app idea
2. It asks up to 3 clarifying questions if the idea has gaps
3. It researches competitors with real web search
4. It evaluates viability against structured criteria
5. It gives a GO or NO-GO recommendation with evidence
6. If GO: it generates the IDEA_VALIDATION_PACKET

## Prerequisites

- An app idea (in natural language)
- WebSearch available (Claude Code includes it by default)
- Does not require Node.js or an existing repo (this step is pre-template)

---

## Internal implementation

### Phase 0: Get the idea

There are no required file inputs. This is the first step of the pipeline.

**If a prior project exists:** read `discipline.md` and `.discipline/packets/IDEA_VALIDATION_PACKET.md` in case there is an earlier validation the user wants to update.

**If there is no prior description, ask:**

```
Describe your app idea:

- What problem does it solve?
- Who has this problem?
- How do they solve it today?

Example: "An app for freelancers with 3+ clients who track hours 
manually in spreadsheets. They lose 30 min/day switching between clients 
and invoicing tools."
```

**Evaluate whether the description covers the 4 axes:**

1. **Problem**: Is it clear what pain it solves?
2. **User**: Is it clear who uses it and whether there are distinct roles?
3. **Key actions**: Is it clear what the user can do?
4. **Data**: Is it clear what information gets stored?

If 1 or more axes are missing, ask up to 3 clarifying questions in a single message. Do not ask them one at a time.

```
Before I research, I need to clarify:

1. Is the tracker just for you or for a team?
2. Do you need to invoice directly from the app, or only track hours?

With that I have what I need.
```

Rules:
- At most 3 questions
- Only ask what cannot be reasonably assumed
- Do not ask about technology (that gets decided later)
- Prioritize questions that affect viability

### Phase 1: Research and evaluation

**Sub-phase 1A: Evaluate the problem and severity**

Extract from the description:
1. Problem in 1 sentence (not vague, not "manage it better")
2. Specific user (not "anyone", not "everyone")
3. Severity (1-10):
   - 1-4: people live with it and are not bothered
   - 5-7: they actively use workarounds
   - 8-10: they actively look for a solution and would pay

**Sub-phase 1B: Market research (WebSearch)**

Look for 5 existing solutions. Use these search queries:

1. "[problem] app" or "[problem] software"
2. "[problem] [user type] tool"
3. "best [category] app 2026"
4. Site-specific: "site:producthunt.com [category]", "site:alternativeto.net [category]"

For each competitor found, document:

| Competitor | What it solves | Price | Weakness / gap |
|---|---|---|---|
| Name 1 | ... | Free / $X/mo | Does not cover X |
| Name 2 | ... | $X/mo | Too complex for Y |
| ... | ... | ... | ... |

If 5 competitors are not found, document how many were found and why the market appears underserved.

**Sub-phase 1C: Gap analysis**

Based on the competitors found:
1. What does NO competitor cover well?
2. Is there an underserved segment of users?
3. Is there a specific use case that nobody solves?

**Sub-phase 1D: Evaluate the differentiator**

The user's differentiator must be concrete, not "better UX". Valid examples:
- "works offline" (when no competitor does)
- "10x cheaper" (when competitors charge a lot)
- "specialized for [niche]" (when competitors are generic)
- "integrates with [tool]" (when there is an integration gap)

If the user's differentiator is vague, flag it and suggest alternatives based on the gaps found.

**Sub-phase 1E: MVP hypothesis**

Formulate: "If I build [minimal X], [user] will do [Y] instead of [current alternative]."

Define the 3 maximum slices to test the hypothesis:
1. Slice 0: bootstrap (always)
2. Slice 1: core action
3. Slice 2: key differentiator

If the hypothesis needs more than 3 slices to be tested, the MVP is too big.

**Sub-phase 1F: GO / NO-GO decision**

Apply the criteria:

**GO if:**
- [ ] Clear problem (1 sentence, not vague)
- [ ] Specific user identified
- [ ] Severity >= 5
- [ ] Real, concrete differentiator
- [ ] MVP demonstrable in <= 3 slices
- [ ] (If selling) Can name 3 people who would pay

**NO-GO if:**
- Problem is fuzzy or unclear
- Severity < 5
- 3+ mature competitors with no clear gap
- MVP requires > 5 slices
- Differentiator is only "better UX" or "prettier"

### Phase 2: Generate output

**If GO:**

Generate `.discipline/packets/IDEA_VALIDATION_PACKET.md`:

```markdown
# IDEA_VALIDATION_PACKET

STATUS: ready
SOURCE_STEP: Step 0a
GENERATED: <date>

## Problem
<1 clear sentence>

## Target user
<specific persona>

## Severity
<1-10 with justification>

## Existing solutions
| Competitor | What it solves | Price | Weakness |
|---|---|---|---|
| ... | ... | ... | ... |

## Identified gap
<what no competitor covers>

## Differentiator
<concrete and verifiable>

## MVP: central hypothesis
"If I build [X], [user] will do [Y] instead of [Z]."

## MVP: maximum slices
1. <slice 0: bootstrap>
2. <slice 1: core>
3. <slice 2: differentiator>

## Decision
GO - <date>

## Evidence
- <sources consulted>
- <competitors evaluated>
- <criteria met>
```

**If NO-GO:**

Do not generate a packet. Present the decision with options:

```
Recommendation: NO-GO

Main reason: <reason>

Options:
1. Pivot: change the user, problem, or differentiator
2. Shrink: make the MVP even smaller
3. Validate first: talk to 5 users before building
4. Drop it: look for another idea

Which do you prefer?
```

If the user wants to pivot, go back to Phase 1 with the new direction.

### Phase 3: Post-processing

If GO and there is an existing repo:
```bash
npm run discipline:assemble -- --step 1
npm run discipline:log -- --step 0a --tool "Claude + WebSearch" --notes "Automated via /discipline-step0a. Decision: GO."
```

If GO and there is no repo yet:
```
IDEA_VALIDATION_PACKET saved.
Next: pick your lane (see the lane-selection guide in The App Discipline vault, sold separately) -> clone the Template Repo -> run /discipline-step1.
```

### Phase 4: Summary

```
Step 0a complete.

Decision: <GO / NO-GO>
Competitors evaluated: <N>
Severity: <N>/10
Differentiator: <summary>

<If GO:>
File generated: .discipline/packets/IDEA_VALIDATION_PACKET.md
Next: pick lane -> clone template -> /discipline-step1

<If NO-GO:>
Options presented. Waiting on the operator's decision.
```

---

## Error handling

- If WebSearch is not available: warn that the research will be limited. Generate the analysis with available knowledge but flag it: "Research done without WebSearch - manually validate the existing solutions."
- If no competitors are found: do not assume the market is empty. Flag it: "Market potentially underserved, or search terms insufficient. Research manually."
- If the user does not answer the clarifying questions: generate the evaluation with what is available, but lower the confidence level of the decision.
- If the user insists on GO when the criteria say NO-GO: respect the decision but document the risks explicitly in the packet.

---

## Critical rules

- Use WebSearch for real research. Do not invent competitors or prices.
- Do not inflate the severity to force a GO. Be honest.
- Do not invent differentiators. If the user does not have a clear one, say so.
- The MVP must fit in 3 slices. If it does not fit, the scope is too big.
- Do not ask about technology. That gets decided when picking the lane and in Step 1.
- The GO/NO-GO decision is a recommendation. The operator decides. If they insist on GO, document the risks.
- The sources consulted must be listed in the packet for traceability.
- This step should take 30 minutes at most. Do not over-research.
