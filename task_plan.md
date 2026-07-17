# task_plan.md — Plan by Phases + Slices

## 1) Current Goal
- N/A

## 2) Definition of Ready
- clear contracts
- clear states
- clear acceptance criteria

## 3) Definition of Done
- gate passes
- docs updated
- packet emitted

## 4) Ready Slices

## Slice 0 - Bootstrap & Backend Confirmation
### Goal
Verify base project setup and the backend decision.
#### Scope IN
- Confirm BACKEND_PROVIDER in discipline.md (ships as LOCAL_ONLY; if you change it, run `npm run discipline:provider:generate`)
- Install SDK if needed
- Run `npm run backend:smoke`
- Confirm gate passes
#### Scope OUT
- Business logic
- UI beyond template shell
#### Contracts
- Backend adapter returns valid User and Space objects
#### UI States
- Template shell with 4 states (loading, empty, error, normal)
#### Acceptance Criteria
- [ ] `npm run gate` passes
- [ ] `npm run backend:smoke` passes
- [ ] discipline.md updated with project switches
#### Notes
- If BACKEND_PROVIDER=LOCAL_ONLY, no SDK install needed

## 5) Deferred / Later
- N/A

## 6) Risks and Dependencies
- N/A
