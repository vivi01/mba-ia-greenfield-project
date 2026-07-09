---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-07-02
scope_description: "Backend video pipeline: object storage access, background processing queue + worker, non-blocking 10GB upload handshake, automatic processing (metadata + thumbnail via FFmpeg), unique public URL, and streaming/download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the entire phase: the video module (entity, draft pre-registration, upload handshake, status lifecycle), the object-storage integration, the processing queue and its worker (FFmpeg metadata + thumbnail), unique-URL generation, and streaming/download delivery. Also owns the new `compose.yaml` services (object storage, queue broker, worker container).
- `next-frontend/` — **Frontend deferred, no open decision in this document.** Phase 03 is a backend-only challenge (per `docs/briefing-fase-03/01-objective-and-scope.md`). The upload protocol (TD-03) and delivery contract (TD-09) define contracts a future frontend phase (Fases 04–05) will consume, but no frontend code is built here.

> **Version note:** BullMQ, the AWS S3 SDK family, an FFmpeg wrapper (if chosen), and the unique-URL library are **not yet installed** in `nestjs-project/package.json` — they are new dependencies introduced by this phase. Candidate versions are cited per TD from current documentation (via context7); the exact pins are locked later in `library-refs.md` during `plan-resolve`, validated against what actually installs on NestJS 11 / Node 22.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` leaves the queue explicitly open ("Message Queue — TBD" in the architecture). Video processing (metadata extraction + thumbnail) is heavy and must run outside the request cycle. This is the phase's main stack decision: it determines whether a new broker container is added to Compose, how the worker (TD-06) consumes jobs, and how retries/failure (TD-05) are expressed. The stack already includes PostgreSQL 17; no Redis is present yet.

**Options:**

### Option A: BullMQ + `@nestjs/bullmq` (Redis-backed)
- Redis-backed queue with a first-class NestJS wrapper (`@nestjs/bullmq`, `BullModule.registerQueueAsync`, `@Processor`/`WorkerHost`). Requires adding a Redis container to Compose.
- **Pros:** De-facto standard for NestJS background jobs; official Nest integration with DI-friendly producers and `WorkerHost` processors. Built-in retries with backoff (`attempts`/`backoff`), delayed jobs, concurrency control, stalled-job recovery, and a mature ecosystem (Bull Board UI). Clean separation for a dedicated worker process (TD-06) sharing the same queue.
- **Cons:** Adds Redis as new infrastructure (one more Compose service and a runtime dependency). Redis persistence must be considered for durability. Two moving parts (broker + client lib) to learn/operate.

### Option B: pg-boss (PostgreSQL-backed)
- Job queue built on the existing PostgreSQL instance using `SKIP LOCKED`. No new broker container — reuses the DB already in the stack.
- **Pros:** Zero new infrastructure — no Redis, one fewer container. Jobs are transactional with domain data (a draft row and its enqueue can share a DB transaction). Durability comes free from Postgres. Simpler ops footprint for a single-instance deployment.
- **Cons:** No official NestJS wrapper (manual module/provider wiring). Puts queue load on the primary DB (competes with video/query traffic). Smaller ecosystem, no polished dashboard. Diverges from the architecture diagram, which models the queue as a separate container.

### Option C: RabbitMQ via `@nestjs/microservices`
- Dedicated AMQP broker consumed through Nest's microservices transport.
- **Pros:** Purpose-built broker with strong routing, durable queues, and dead-letter exchanges. Nest has a native transport. Scales to many workers/consumers cleanly.
- **Cons:** Heaviest operational overhead (broker + management plane). AMQP semantics are more than a single processing queue needs here. The microservices transport is oriented to message patterns, not job-with-progress semantics — retries/backoff/progress need more manual modelling than BullMQ provides out of the box.

**Recommendation:** **Option A (BullMQ + `@nestjs/bullmq`)** — It matches the architecture diagram's "separate queue container", gives the richest job semantics (retries/backoff/stalled recovery/progress) needed for TD-05's failure handling with the least custom code, and has first-class NestJS support that keeps the worker (TD-06) idiomatic. The cost is one Redis container — acceptable for a Docker-Compose dev stack. pg-boss is the strong fallback if avoiding Redis becomes a hard constraint. Candidate versions: `bullmq` ^5, `@nestjs/bullmq` ^11, `redis:7-alpine` (or `valkey`).

**Decision:** Option A

---

## TD-02: Object Storage Client & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is *given* as S3-compatible (MinIO locally, S3 in prod — per `docs/briefing-fase-03/02-technical-decisions-to-make.md`). The open decision is **how the backend talks to it**: which client library, how to point it at the MinIO container (custom endpoint, path-style addressing), and how buckets/keys are organized for originals vs thumbnails. This client is used by the API (to issue upload credentials, TD-03) and by the worker (to read the original and write the thumbnail, TD-06).

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + presigner packages)
- Official modular AWS SDK. `S3Client` configured with `endpoint` (the `minio` Compose service URL) and `forcePathStyle: true` for MinIO. Presigning via `@aws-sdk/s3-request-presigner` (PUT/GET), `@aws-sdk/s3-presigned-post` (POST policy with size conditions), and `@aws-sdk/lib-storage` (`Upload`) / native multipart commands for large files.
- **Pros:** Canonical, first-class TypeScript, huge documentation surface. One SDK covers presigned PUT, presigned POST-policy, and multipart — directly enabling every option in TD-03. Same API against MinIO (dev) and S3 (prod) by swapping only `endpoint`/credentials. Actively maintained.
- **Cons:** Modular but still several packages to add. API is verbose (command objects). Slightly larger dependency footprint than a minimal client.

### Option B: MinIO JavaScript SDK (`minio`)
- MinIO's own client. Higher-level helpers (`presignedPutObject`, `presignedGetObject`, `fPutObject`).
- **Pros:** Ergonomic, MinIO-tuned API; concise presigned-URL helpers. Works against S3 too.
- **Cons:** Second abstraction that still speaks S3 under the hood; prod on real S3 is better served by the AWS SDK. Smaller ecosystem for advanced multipart/POST-policy flows. Risks coupling code to MinIO-specific ergonomics.

### Option C: `s3-lite-client` (lightweight, dependency-free)
- Minimal S3 client supporting presigning and multipart across runtimes.
- **Pros:** Tiny, zero-dependency, fast; covers presigned URLs and multipart.
- **Cons:** Lower adoption; smaller docs/community. Less battle-tested for a 10GB multipart path than the AWS SDK. Fewer turnkey helpers (e.g., POST-policy) than Option A.

**Recommendation:** **Option A (AWS SDK v3)** — It is the only option that natively supplies *all three* upload mechanics TD-03 weighs (presigned PUT, presigned POST-policy, and multipart via `lib-storage`/multipart commands) from one maintained SDK, works identically against MinIO (`endpoint` + `forcePathStyle`) and prod S3, and has the deepest documentation. Bucket/key layout convention (single bucket, e.g. `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`) is an implementation detail for `implement`, not a separate TD. Candidate versions: `@aws-sdk/client-s3` ^3, `@aws-sdk/s3-request-presigner` ^3, `@aws-sdk/s3-presigned-post` ^3, `@aws-sdk/lib-storage` ^3; `minio/minio` (latest) image.

**Decision:** Option A

---

## TD-03: Large-File Upload Protocol (10GB without blocking the API)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The file (up to 10GB) must reach storage **without streaming through the API** — routing 10GB through the Nest process in a blocking way is an automatic failure (`docs/briefing-fase-03/06-automatic-failure.md`). Hard S3 constraint: a **single PUT is capped at 5GB**; objects larger than 5GB (up to 5TB) **require multipart upload**. So any single-request strategy is disqualified by the 10GB target on its own. This TD chooses the client↔storage transfer mechanism; TD-04 defines the surrounding handshake. (This is effectively a client↔storage contract a future frontend will consume; frontend is out of scope for this phase.)

**Options:**

### Option A: Presigned single PUT URL
- API returns one presigned PUT URL; client uploads the whole file in one request directly to storage.
- **Pros:** Simplest handshake — one URL, one request. No multipart bookkeeping.
- **Cons:** **Disqualified for the 10GB requirement** — S3 caps single PUT at 5GB. No resumability; a dropped connection restarts the entire 10GB transfer. Only viable for small files.

### Option B: Presigned POST policy (`createPresignedPost`)
- API returns a POST `url` + `fields` with a policy that can enforce a **max content-length** and key/prefix conditions; client posts the file (multipart/form-data) directly to storage.
- **Pros:** Lets the backend enforce size/type limits in the signed policy (defense against oversized/abusive uploads). Direct-to-storage, API not in the byte path.
- **Cons:** Still a single POST request — same practical ~5GB ceiling and no resumability. Best for bounded, smaller uploads, not 10GB.

### Option C: Presigned multipart upload (S3 multipart: initiate → presigned part URLs → complete)
- API initiates a multipart upload (`CreateMultipartUpload`), issues **presigned URLs per part**; client uploads parts (≥5MB each) in parallel directly to storage; API completes (`CompleteMultipartUpload`) on confirmation. Optionally the server-side `@aws-sdk/lib-storage` `Upload` helper for server-driven cases.
- **Pros:** The **only** option that satisfies 10GB (multipart supports up to 5TB). Parallel part uploads = throughput; **resumable** (re-upload only failed parts). API stays out of the byte path — it only signs and finalizes. Directly supported by the AWS SDK chosen in TD-02.
- **Cons:** Most complex handshake (init/part-signing/complete, plus abort of stale uploads). More endpoints and client coordination. Requires tracking upload/part state.

### Option D: tus resumable protocol (`@tus/server`)
- Standardized resumable-upload protocol with a tus server, optionally backed by S3.
- **Pros:** Robust resumability and pause/resume as a first-class protocol; good for flaky connections.
- **Cons:** Introduces a separate protocol/server component and (if the tus endpoint is in the API) risks putting bytes back through the Nest process unless offloaded to an S3 store. Heavier than needed given S3 multipart already provides resumability directly against storage. New, less-standard dependency for the team.

**Recommendation:** **Option C (Presigned multipart upload)** — It is the only mechanism that meets the 10GB requirement (single PUT/POST are capped at 5GB), keeps the 10GB bytes entirely off the API (avoiding the auto-fail), and gives resumability + parallelism natively through the AWS SDK already selected in TD-02. Part-size and concurrency are implementation details. tus (Option D) is the fallback if standardized resumable UX later outweighs the extra component. Enforce an upper size bound (10GB) and abort of abandoned multipart uploads.

**Decision:** Option C

---

## TD-04: Upload Handshake & Processing Trigger

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The phase requires a **draft** created automatically when upload *starts*, and processing enqueued automatically when upload *finishes*. This TD defines the end-to-end handshake around the transfer mechanic (TD-03) and, critically, **what triggers processing** once storage holds the file. It ties the video row (TD-05 status), the storage upload (TD-02/03), and the queue (TD-01) together.

**Options:**

### Option A: Explicit init/complete endpoints (app-driven trigger)
- `POST /videos` (init): create the draft row (status `DRAFT`), initiate the multipart upload, return the video id + presigned part URLs. Client uploads parts directly to storage. `POST /videos/{id}/complete`: API calls `CompleteMultipartUpload`, flips status to `PROCESSING`, and **enqueues** the processing job.
- **Pros:** Fully explicit and testable — every transition is an API call under the backend's control. No dependency on storage-event infrastructure. Works identically on MinIO and S3. The complete endpoint is the natural, single place to enqueue and to validate the finished object.
- **Cons:** Relies on the client to call `complete` (mitigated by a reconciliation/abort sweep for abandoned uploads). One extra endpoint.

### Option B: Storage bucket-notification trigger (event-driven)
- Configure MinIO/S3 bucket notifications (e.g., `s3:ObjectCreated:*`) to signal the backend, which then enqueues processing.
- **Pros:** Processing fires from the authoritative storage event; no reliance on a client "complete" call.
- **Cons:** Requires wiring bucket notifications (MinIO webhook/AMQP config) — extra infra and dev↔prod configuration drift. Harder to test deterministically. Notification does not by itself update the domain draft row, so an app path is still needed. Overkill given the app already finalizes multipart in Option A.

**Recommendation:** **Option A (explicit init/complete endpoints)** — The completion of the multipart upload already happens through the backend (TD-03 `CompleteMultipartUpload`), so enqueuing there is a zero-extra-infrastructure, deterministic trigger that keeps the draft lifecycle (TD-05) authoritative and testable. Guard against orphaned uploads with a periodic abort/reconcile of stale multipart sessions (implementation detail). Bucket notifications (Option B) can be added later if a fully client-independent trigger becomes necessary.

**Decision:** Option A

---

## TD-05: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video needs a status model spanning creation → upload → processing → availability, plus a defined outcome when processing fails. This model is the contract shared by the upload handshake (TD-04), the worker (TD-06), and delivery (TD-09, which must only serve `READY` videos). The briefing suggests `draft → processing → ready/error`.

**Options:**

### Option A: Minimal lifecycle — `DRAFT → PROCESSING → READY | ERROR`
- Draft on init, `PROCESSING` on upload completion, `READY` on worker success, `ERROR` on failure. Retries handled by the queue's `attempts`/`backoff`; status flips to `ERROR` only after retries are exhausted.
- **Pros:** Matches the briefing exactly; few states, easy to reason about and test. Retry concerns delegated to BullMQ (TD-01) rather than encoded as extra statuses. Clear terminal states for delivery gating.
- **Cons:** Does not distinguish "uploading" from "draft" or "awaiting processing"; less observability into the in-between phases.

### Option B: Granular lifecycle — `DRAFT → UPLOADING → UPLOADED → PROCESSING → READY | FAILED`
- Adds explicit `UPLOADING`/`UPLOADED` states around the transfer and a distinct `FAILED`.
- **Pros:** Finer observability; can drive richer UI later and clearer reconciliation of abandoned uploads.
- **Cons:** More transitions to enforce and test; several states add little value while the frontend is out of scope. Risk of over-modelling before a consumer needs it.

**Recommendation:** **Option A (minimal lifecycle)** — It fulfils the briefing's `draft → processing → ready/error` verbatim, keeps transitions few and testable, and leans on BullMQ (TD-01) for retry/backoff so transient failures don't pollute the status enum; only exhausted retries yield `ERROR`. On failure, the video stays queryable in `ERROR` (no delivery). Extra states (Option B) can be introduced in a later phase if UI observability demands them.

**Decision:**  Option A

---

## TD-06: Worker Deployment Model

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture models a **separate Video Worker (FFmpeg)** container that consumes the queue, processes videos, and updates DB + storage. This TD decides how that worker is packaged and run relative to the API, and where FFmpeg binaries live. It depends on TD-01 (queue) and constrains the Docker/Compose setup.

**Options:**

### Option A: Separate container, same NestJS codebase, worker-only bootstrap
- One codebase; a distinct entrypoint (e.g., `main.worker.ts` bootstrapping a Nest app/context that registers only the queue `WorkerHost` processors, not the HTTP server). A dedicated `worker` service in `compose.yaml`, built from the same image but with FFmpeg/ffprobe installed and a different command.
- **Pros:** Matches the architecture diagram (separate container). Shares entities, DTOs, storage client, and config with the API — no code duplication, single source of truth. Independent scaling and resource limits (CPU-heavy FFmpeg isolated from API latency). Idiomatic with `@nestjs/bullmq` `WorkerHost`. FFmpeg installed only in the worker image.
- **Cons:** Two runtime targets from one repo (an extra entrypoint + Compose service). Image must include FFmpeg (larger worker image). Care to not start the HTTP listener in the worker bootstrap.

### Option B: Same process as the API (in-process worker)
- The API process also runs the BullMQ worker.
- **Pros:** Simplest — one process, one container, no extra entrypoint.
- **Cons:** CPU-heavy FFmpeg jobs contend with request handling — directly at odds with "sem impacto na performance". Can't scale workers independently. Diverges from the architecture diagram. FFmpeg must live in the API image.

### Option C: Fully separate service/repository
- A standalone project for the worker.
- **Pros:** Maximum isolation and independent deploy cadence.
- **Cons:** Duplicates entities/config/storage code or forces a shared package; heavy for a monorepo phase. Over-engineered for the current scope.

**Recommendation:** **Option A (separate container, shared codebase, worker bootstrap)** — It honours the architecture's separate-worker model and the performance requirement (FFmpeg isolated from the API) while reusing entities, the storage client (TD-02), and config from the same codebase, avoiding duplication. FFmpeg/ffprobe are installed only in the worker image. This is the standard `@nestjs/bullmq` deployment shape.

**Decision:** Option A

---

## TD-07: FFmpeg Integration Approach (metadata + thumbnail)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker (TD-06) must extract duration/metadata (ffprobe) and generate a thumbnail from a frame (ffmpeg). The tool (FFmpeg/ffprobe) is *given*; the open decision is **how Node invokes it** — a wrapper library vs. driving the binaries directly. This affects the dependency surface, control over commands, and maintenance risk.

**Options:**

### Option A: Direct `child_process` spawn of system `ffmpeg`/`ffprobe`
- The worker image installs the FFmpeg suite; Node spawns `ffprobe -print_format json -show_streams -show_format` for metadata and `ffmpeg -ss <t> -i in -frames:v 1 out.jpg` for the thumbnail, parsing stdout/exit codes.
- **Pros:** Zero third-party wrapper — no stale-dependency risk. Full, explicit control of the exact CLI invocation and error handling. Small dependency footprint. `ffprobe -show_streams -show_format` returns exactly the JSON the metadata step needs.
- **Cons:** Manual process/stream/error handling and JSON parsing (a thin internal helper). Slightly more boilerplate than a fluent API.

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API: `ffmpeg().screenshots({...})` for thumbnails, `ffmpeg.ffprobe(...)` for metadata, `setFfmpegPath`/`setFfprobePath` to point at the binaries.
- **Pros:** Ergonomic, well-documented API; concise thumbnail/`ffprobe` helpers; abstracts argument building.
- **Cons:** **Maintenance risk** — the canonical `fluent-ffmpeg/node-fluent-ffmpeg` package is effectively unmaintained; the actively-updated material is a community fork (`thedave42`), so the "current" choice is a fork, not the headline package. Adds an abstraction over what is ultimately a CLI. `screenshots()` has documented caveats (no input streams, imprecise progress, poor filter interaction).

**Recommendation:** **Option A (direct `child_process` spawn)** — For only two operations (ffprobe metadata + single-frame thumbnail), spawning the binaries directly gives full control with **no dependency on an unmaintained wrapper** (fluent-ffmpeg's maintained path is a fork, a maintenance liability), keeps the footprint minimal, and `ffprobe -print_format json -show_streams -show_format` yields precisely the duration/metadata JSON required. A thin internal wrapper covers spawn/parse/error. `fluent-ffmpeg` (using the maintained fork) is an acceptable fallback if the team prefers its ergonomics. FFmpeg binaries are provided by the worker image (TD-06).

**Decision:** Option A

---

## TD-08: Unique Public URL Generation

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, URL-safe public identifier (a "slug"/short id) distinct from the internal DB id, never colliding with another video (`docs/project-plan.md` §Pontos de Atenção: "URL curta e única"). Stored on the video row with a unique constraint; used by delivery (TD-09) to resolve a video from its public URL.

**Options:**

### Option A: `nanoid`
- Generates compact, URL-safe, cryptographically-random ids (e.g., 11–12 chars). Custom alphabet/length supported.
- **Pros:** Purpose-built for short URL-safe ids; tiny, secure default RNG; tunable length to balance shortness vs. collision probability. Widely used.
- **Cons:** v5 is **ESM-only** — importing from NestJS's CommonJS output needs dynamic `import()` or pinning to v3 (last CJS line). A version/interop decision to make explicit at lock time.

### Option B: Node built-in `crypto` (base62/base64url of random bytes)
- `crypto.randomBytes(n)` encoded to a URL-safe alphabet (base64url or custom base62); or `crypto.randomUUID()` if a longer id is acceptable.
- **Pros:** Zero dependency — nothing to install or version. Cryptographically strong. No ESM/CJS friction. Full control over length/alphabet.
- **Cons:** Small amount of custom encoding code (or a longer, less "pretty" UUID). `randomUUID()` is 36 chars — not "short".

### Option C: `hashids` / DB-sequence encoding
- Encode a monotonic DB sequence into a short reversible string.
- **Pros:** Guaranteed uniqueness from the sequence; short output.
- **Cons:** Reversible/enumerable ids can leak volume and allow guessing/scraping — undesirable for public URLs. Extra dependency and a salt to manage.

**Recommendation:** **Option A (`nanoid`)** — It is the standard, right-sized tool for short unique public URLs with a secure default RNG and tunable length; a DB unique constraint (with regenerate-on-conflict) makes collisions a non-issue. Resolve the ESM/CJS interop explicitly at lock time (pin v3 for straightforward CommonJS `require`, or dynamic-import v5). If avoiding any dependency is preferred, Node's built-in `crypto` (Option B, base64url of random bytes) is an equally secure zero-dep fallback. Avoid reversible/enumerable ids (Option C) for public URLs.

**Decision:** Option A

---

## TD-09: Video Delivery — Streaming (Range) & Download

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must stream without a full download (HTTP Range / `206 Partial Content`), and the user must be able to download the file. Both are "how the bytes reach the client" and share one decision: does the API sit in the byte path, or does the client fetch bytes directly from storage? Consistency with the phase's core constraint (do not push large files through the API) makes this decision architecturally significant. Delivery serves only `READY` videos (TD-05) and resolves the video via its public URL (TD-08).

**Options:**

### Option A: Presigned GET / redirect to storage (storage serves Range natively)
- The API resolves the public URL → issues a short-lived presigned GET URL (or `302` redirect) to storage. The client streams directly from MinIO/S3, which supports HTTP Range/`206` natively. Download is the same URL with `response-content-disposition=attachment`.
- **Pros:** API stays out of the byte path — consistent with the no-large-files-through-API principle and best for a 10GB-scale platform. Storage handles Range/`206`, parallelism, and CDN-ability for free. Download vs. stream differ only by the `Content-Disposition` response header on the signed URL.
- **Cons:** Exposes a (temporary, expiring) storage URL to the client. Access control is enforced at signing time, not per-byte. Presigned-URL expiry/refresh must be handled.

### Option B: API proxies Range requests (app in the byte path)
- The API handles `GET` with a `Range` header, reads the requested byte range from storage, and returns `206 Partial Content`; download streams the object with `Content-Disposition: attachment`.
- **Pros:** Full control over access/authorization on every request; storage URLs never exposed. Central place for view counting/logging.
- **Cons:** Routes video bytes through the Nest process — the exact pattern the phase warns against at upload time, now on the read side; scales poorly for large files and concurrency. Higher API CPU/memory and bandwidth cost. Must implement Range parsing/`206` correctly by hand.

**Recommendation:** **Option A (presigned GET / redirect to storage)** — It keeps the API out of the byte path for delivery just as TD-03 does for upload, lets storage serve Range/`206` and downloads natively (download = same signed URL with an attachment `Content-Disposition`), and scales to 10GB files and many concurrent viewers. Short-lived signed URLs provide access control at issue time; expiry is tuned per need. The API-proxy approach (Option B) is the fallback only if per-request authorization or hiding storage URLs becomes a hard requirement — accepting the throughput cost.

**Decision:** Option A


---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | A (BullMQ + `@nestjs/bullmq`, Redis) | A |
| TD-02 | Backend | Object Storage Client & Bucket/Key Organization | A (AWS SDK v3) | A |
| TD-03 | Backend | Large-File Upload Protocol (10GB) | C (Presigned multipart upload) | C |
| TD-04 | Backend | Upload Handshake & Processing Trigger | A (Explicit init/complete endpoints) | A |
| TD-05 | Backend | Video Status Lifecycle & Failure Handling | A (Minimal `DRAFT→PROCESSING→READY\|ERROR`) | A |
| TD-06 | Backend | Worker Deployment Model | A (Separate container, shared codebase) | A |
| TD-07 | Backend | FFmpeg Integration Approach | A (Direct `child_process` spawn) | A |
| TD-08 | Backend | Unique Public URL Generation | A (`nanoid`) | A |
| TD-09 | Backend | Video Delivery — Streaming & Download | A (Presigned GET / redirect to storage) | A |
