# 05 - Acceptance Criteria (single evaluation checklist)

> Source: the statement section "Acceptance Criteria".
> **All items are mandatory. This is the single evaluation list.** Review them
> item by item before pushing.

## Decisions and planning

- [ ] `technical-decisions-phase-03-videos.md` with the open decisions
      **resolved and justified** (queue, upload strategy, streaming,
      processing/thumbnail, status lifecycle)
- [ ] Folder `docs/phases/phase-03-videos/` with `context.md`, `validation.md`
      (**status `clean`**), the `phase-03-videos.md` plan, `progress.md`, and
      `library-refs.md` (expected in this phase)
- [ ] The plan follows the project format: SIs `SI-03.x`, Technical
      Specifications (Data Model, API Contracts, Authorization Matrix, Error
      Catalog, **Events/Messages**), Dependency Map, and Deliverables

## Implementation - feature

- [ ] Video upload of **up to 10GB without blocking** the API, with draft
      pre-registration when it starts
- [ ] Automatic processing after upload: duration/metadata extraction and
      thumbnail generation
- [ ] **Unique URL** per video, without conflicts
- [ ] **Streaming** working (without requiring a full download) and **video
      download** available
- [ ] Video status lifecycle (draft -> processing -> ready/error) reflected in
      the database

## Implementation - infrastructure and quality

- [ ] Object storage, queue, and worker **starting via `docker compose`** with
      the backend
- [ ] Migration creates the videos table; entity **linked to the channel**
- [ ] Tests at the right levels, **green** (`npm test` and `npm run test:e2e`)
- [ ] **Full Definition of Done**: green suite + `npx tsc --noEmit` (code 0) +
      `npm run lint`
- [ ] Git Flow respected (work in `feature/*` from `dev`, no direct commit to
      `main`)

## Documentation and tooling

- [ ] `CLAUDE.md` updated with the **video section, coherent with the code**
      (module, endpoints, queue/worker, storage) - documentation that cites
      nonexistent files or behaviors fails
- [ ] If another tool was used instead of Claude Code: the AI foundation was
      **ported** to its convention and the phase folder artifacts were
      delivered in the same format

---

Automatic failure conditions are in
[`06-automatic-failure.md`](06-automatic-failure.md).
