# 06 - Automatic Failure (guardrail)

> Source: the statement section "Automatic failure".
> Any one of these **automatically fails the delivery**. Treat them as a
> guardrail in all stages.

- ❌ **Skipping the workflow:** implementing without the research, planning,
  and implementation stages (and their artifacts).
- ❌ **Plan without SIs or without the Technical Specifications**, or a
  `validation.md` that does **not close as `clean`**.
- ❌ **Passing the 10GB file through the API** in a way that blocks the system
  (without an asynchronous/direct upload strategy).
- ❌ **Not having real queue, worker, and storage services starting in Compose.**
- ❌ **`tsc` with errors, broken lint, or red tests.**
- ❌ **Direct commit to `main`.**
- ❌ **`CLAUDE.md` (or equivalent) inconsistent with the code.**
- ❌ **Using another tool without porting the AI foundation** to its
  convention.

## Quick map: how to avoid each one

| Failure | Prevention | Where |
|---------|------------|-------|
| Skip workflow | Follow the 7 stages in order | [`03-workflow-and-artifacts.md`](03-workflow-and-artifacts.md) |
| Incomplete plan / `validation` not `clean` | Iterate validate ⇄ resolve; SIs + Technical Specs in the plan | [`03-workflow-and-artifacts.md`](03-workflow-and-artifacts.md) |
| 10GB through the API | Direct upload to storage (pre-signed URL / multipart) | [`02-technical-decisions-to-make.md`](02-technical-decisions-to-make.md) |
| Infra does not start in Compose | storage + queue + worker in `compose.yaml`, using the service name | [`04-rules-and-definition-of-done.md`](04-rules-and-definition-of-done.md) |
| tsc / lint / tests | Full Definition of Done before closing | [`04-rules-and-definition-of-done.md`](04-rules-and-definition-of-done.md) |
| Commit on `main` | `feature/*` from `dev`, merge into `dev` | [`04-rules-and-definition-of-done.md`](04-rules-and-definition-of-done.md) |
| Docs inconsistent | Update `CLAUDE.md` to reflect the real code at the end | [`05-acceptance-criteria.md`](05-acceptance-criteria.md) |
