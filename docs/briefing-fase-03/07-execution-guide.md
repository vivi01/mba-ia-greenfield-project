# 07 - Execution Guide and Deliverable Structure

> Source: the statement sections "Suggested execution order", "Requirements",
> and "Deliverable structure".

## Suggested execution order

### 1. Setup

- Fork the repository (work inside the `mba-ia-greenfield-project` fork — do
  not create a new repository).
- Start the backend: `cd nestjs-project && docker compose up -d`, install
  dependencies, run migrations.
- **Confirm the current suite is green** before starting.
- If you use a tool other than Claude Code, **port the AI foundation**
  (`CLAUDE.md`, skills/sub-agents, `.mcp.json`) to its convention before you
  start.

### 2. Research

- Research and **close the open decisions** (queue, upload strategy,
  streaming, processing). Object storage is already given (S3/MinIO).
- Details: [`02-technical-decisions-to-make.md`](02-technical-decisions-to-make.md).

### 3. Planning (pipeline)

- Run `context -> validate -> resolve -> build` until `validation.md` closes as
  **`clean`** and the plan is complete. **Critically review** every output.
- Details: [`03-workflow-and-artifacts.md`](03-workflow-and-artifacts.md).

### 4. Implementation (SI by SI)

Drive implementation through the `implement` skill, SI by SI, running tests at
each step and advancing only with the SI suite green. Includes:

- The **video module** in the backend (shape reference: `auth/`).
- The **new infra in `compose.yaml`**: object storage, queue, and worker,
  starting with the backend stack.
- The **migration** that creates the video table.
- The **tests** at the right levels (do not mock what can be tested for real
  with the Compose infra).
- The phase `progress.md` updated (status + tests per SI).

### 5. Closure

- Ensure the **Definition of Done** (tests + `tsc` + lint).
- Update `CLAUDE.md` with the video section, coherent with the code.
- Review the **Acceptance Criteria item by item** before pushing
  ([`05-acceptance-criteria.md`](05-acceptance-criteria.md)).

## Deliverable structure

Only the **new/changed** parts (module file names are illustrative — the final
structure is a plan decision):

```
mba-ia-greenfield-project/
├── docs/
│   ├── decisions/
│   │   └── technical-decisions-phase-03-videos.md     <- research
│   └── phases/
│       └── phase-03-videos/                           <- phase folder
│           ├── context.md                             <- plan-context
│           ├── validation.md                          <- plan-validate (clean)
│           ├── library-refs.md                        <- plan-resolve
│           ├── phase-03-videos.md                     <- plan-build (the plan)
│           └── progress.md                            <- implement
├── nestjs-project/
│   ├── CLAUDE.md (or equivalent)                      <- updated
│   ├── compose.yaml                                   <- + storage, queue, worker
│   ├── src/
│   │   ├── videos/                                    <- new module (ref.: auth/)
│   │   │   └── ...
│   │   └── database/migrations/
│   │       └── <timestamp>-CreateVideos.ts
│   └── (video worker - local according to your plan)
└── CLAUDE.md (or equivalent)                         <- updated
```

## Base repository

- Fork of <https://github.com/devfullcycle/mba-ia-greenfield-project>.
- It already includes Phases 01 and 02 (backend and frontend), the complete
  workflow in `.claude/` (skills, sub-agents, and rules), `CLAUDE.md`,
  `docs/project-plan.md`, and the backend `compose.yaml` with Postgres and
  Mailpit.

## Relevant skills available in the repo

From `.claude/skills/` - the pipeline skills: `research`, `plan-context`,
`plan-validate`, `plan-resolve`, `plan-build`, `plan-test-specs`, `implement`
(and orchestrators `plan-pipeline` / `plan-phase` / `implement-phase`).
Support skills: `nestjs-best-practices`, `typeorm`,
`testing-guide-nestjs-project`.

Go back to the index: [`00-briefing-index.md`](00-briefing-index.md).
