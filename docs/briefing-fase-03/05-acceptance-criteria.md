# 05 - Acceptance Criteria (single evaluation checklist)

> Source: the statement section "Acceptance Criteria".
> **All items are mandatory. This is the single evaluation list.** Review them
> item by item before pushing.
>
> **Status: ALL ITEMS MET.** Verified 2026-07-03 against the delivered code on
> branch `feature/phase-03-videos`. Evidence is annotated per item.

## Decisions and planning

- [x] `technical-decisions-phase-03-videos.md` with the open decisions
      **resolved and justified** (queue, upload strategy, streaming,
      processing/thumbnail, status lifecycle)
      — TD-01…TD-09 each carry a **Recommendation** + justification, plus a
      **Decisions Summary** table (queue=BullMQ, upload=multipart/presigned,
      streaming/download=presigned GET, FFmpeg=direct spawn, lifecycle=draft→
      processing→ready/error).
- [x] Folder `docs/phases/phase-03-videos/` with `context.md`, `validation.md`
      (**status `clean`**), the `phase-03-videos.md` plan, `progress.md`, and
      `library-refs.md` (expected in this phase)
      — all five present; `validation.md` is `status: clean`, `issue_count: 0`;
      `library-refs.md` documents BullMQ, AWS SDK v3, nanoid, and FFmpeg.
- [x] The plan follows the project format: SIs `SI-03.x`, Technical
      Specifications (Data Model, API Contracts, Authorization Matrix, Error
      Catalog, **Events/Messages**), Dependency Map, and Deliverables
      — `phase-03-videos.md` contains all listed sections (SI-03.1…03.9 plus the
      `### Data Model`, `### API Contracts`, `### Authorization Matrix`,
      `### Error Catalog`, `### Events/Messages`, `## Dependency Map`,
      `## Deliverables` headings).

## Implementation - feature

- [x] Video upload of **up to 10GB without blocking** the API, with draft
      pre-registration when it starts
      — `POST /videos` pre-registers a `draft` row and returns a presigned URL;
      `@aws-sdk/lib-storage` multipart keeps 10GB transfers off the API process.
- [x] Automatic processing after upload: duration/metadata extraction and
      thumbnail generation
      — `POST /videos/:id/complete` enqueues `process-video`; the worker runs
      ffprobe (duration/metadata) + ffmpeg (thumbnail) and persists the results.
- [x] **Unique URL** per video, without conflicts
      — `public_id` is a 21-char nanoid with a unique DB constraint; used by
      `GET /videos/:publicId`.
- [x] **Streaming** working (without requiring a full download) and **video
      download** available
      — `GET /videos/:publicId/stream` (inline, Range-capable) and
      `GET /videos/:publicId/download` (`attachment` disposition), both 302
      redirects to presigned GET URLs.
- [x] Video status lifecycle (draft -> processing -> ready/error) reflected in
      the database
      — `status` enum on the `videos` table; transitions on complete (processing)
      and on worker success/final-failure (ready/error).

## Implementation - infrastructure and quality

- [x] Object storage, queue, and worker **starting via `docker compose`** with
      the backend
      — `compose.yaml` defines `minio` (+ `minio-init` bucket bootstrap),
      `redis`, and `video-worker`; the worker runs the same image with
      `VIDEO_WORKER=true`.
- [x] Migration creates the videos table; entity **linked to the channel**
      — `1783020452709-CreateVideos.ts` creates `videos` with a FK
      `channel_id → channels(id)`; `video.entity.ts` maps the `@ManyToOne` channel.
- [x] Tests at the right levels, **green** (`npm test` and `npm run test:e2e`)
      — unit+integration 33 suites / 191 tests green; E2E 6 suites / 67 tests green.
- [x] **Full Definition of Done**: green suite + `npx tsc --noEmit` (code 0) +
      `npm run lint`
      — `tsc --noEmit` exits 0; `npm run build` OK; `npm run lint` 0 errors.
- [x] Git Flow respected (work in `feature/*` from `dev`, no direct commit to
      `main`)
      — work on `feature/phase-03-videos`, branched from and descending `dev`;
      no commits to `main`.

## Documentation and tooling

- [x] `CLAUDE.md` updated with the **video section, coherent with the code**
      (module, endpoints, queue/worker, storage) - documentation that cites
      nonexistent files or behaviors fails
      — `nestjs-project/CLAUDE.md` gained a **Videos Pipeline** section (endpoint
      table, storage adapter, queue/worker, `VIDEO_WORKER` isolation) and the
      full Compose service list; root `CLAUDE.md` resolves the queue to
      BullMQ/Redis. All cited files/behaviors exist in the code.
- [x] If another tool was used instead of Claude Code: the AI foundation was
      **ported** to its convention and the phase folder artifacts were
      delivered in the same format
      — N/A: implemented with Claude Code; artifacts follow the existing phase
      folder format.

---

Automatic failure conditions are in
[`06-automatic-failure.md`](06-automatic-failure.md).
