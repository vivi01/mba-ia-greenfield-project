# 04 - Project Rules and Definition of Done

> Source: the statement section "Rules and Definition of Done" + `CLAUDE.md`.
> These `CLAUDE.md` rules apply to this phase.

## Definition of Done (technical)

The phase is only done when **all** of the following pass:

1. The **relevant** test suite passes (unit + integration + e2e affected by
   the change).
2. The **full** test suite passes before finishing.
3. **`npx tsc --noEmit` exits with code 0.** Compilation errors never remain as
   debt.
4. **`npm run lint` passes.**

If any of these fail, the task is **not done** — fix the root cause.

> `tsc` with errors, broken lint, or a red suite is **automatic failure**.

## Docker

Everything runs in containers. Always use the **Compose service name** as the
host (e.g. `db`, `nestjs-api`), **never** `localhost` / `127.0.0.1`.

- **Correct:** `DB_HOST=db`
- **Wrong:** `DB_HOST=localhost`

This applies to env vars, config files, and code. It also applies to the new
services: **storage, queue, and worker** must start together with the backend
stack via `docker compose`.

## Library documentation (context7 - mandatory)

Before implementing with **any library**, consult the official docs via
**context7** (MCP) and follow the installed version:

- Check the installed version in the project manifest (`package.json`).
- Retrieve the corresponding docs via context7.
- Cross-check the APIs to avoid deprecated/incompatible patterns.
- Follow the official docs over training data.
- If the docs do not match the installed version, **flag the discrepancy**
  before proceeding.

The new libraries confirmed are fixed in the phase's `library-refs.md`.

## Git Flow

- **Never** commit directly to `main` (automatic failure).
- `feature/*` branches start from **`dev`** and merge back into **`dev`**.
- Two long-lived branches: `main` (stable) and `dev` (integration). When `dev`
  is stable, it is merged into `main`.
- Commits should be **short and descriptive**, focused on the "why".

## Testing convention

- `*.spec.ts` -> **unit**
- `*.integration-spec.ts` -> **integration** (with real DB/services)
- `*.e2e-spec.ts` -> **e2e** (via supertest)

Phase test rules:

- Tests at the **right levels** (unit, integration, e2e), according to the
  project test skills (`testing-guide-nestjs-project`).
- **Do not mock what can be tested for real** with the Compose infrastructure.
- Green commands: `npm test` and `npm run test:e2e`.
- The phase `progress.md` must reflect **status + tests per SI**, like in
  Phase 02.

## Code principles (from `CLAUDE.md`)

- **Single Responsibility:** each module/service/function has a focused
  responsibility. If a module starts owning logic/entities from another domain,
  **extract** it immediately into the proper module instead of deferring it.
- **Type Safety:** strict TypeScript across all layers.
- **Testing:** emphasis on the testing pyramid at all levels.
- **Code Quality:** ESLint + Prettier.
- The video module follows the project **conventions and rules** (layer
  separation, repository pattern, use of queue/events, transactions). Use the
  `auth/` module as a **shape reference** — the concrete file structure is a
  plan decision, not dictated by the statement.

The final acceptance checklist is in
[`05-acceptance-criteria.md`](05-acceptance-criteria.md).
