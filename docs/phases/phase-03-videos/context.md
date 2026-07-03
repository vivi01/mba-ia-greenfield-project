---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T18:20:37-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T10:50:56-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-06-26T18:20:37-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-26T18:20:37-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-26T18:20:36-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in `project-plan.md`. The Fase 03 challenge is backend-only; frontend video UI (upload/player/management screens) belongs to Fases 04–05._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (backend owns upload, storage, queue, worker, and processing).

**Deferred subprojects:** `next-frontend/` — video UI deferred to a later phase; no frontend code in this phase.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background processing queue technology | decided | A (BullMQ + @nestjs/bullmq, Redis) | — |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object storage client & bucket/key layout | decided | A (AWS SDK v3) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Large-file upload protocol (10GB) | decided | C (Presigned multipart upload) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Upload handshake & processing trigger | decided | A (Explicit init/complete endpoints) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video status lifecycle & failure handling | decided | A (Minimal `DRAFT→PROCESSING→READY\|ERROR`) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Worker deployment model | decided | A (Separate container, shared codebase) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | FFmpeg integration approach | decided | A (Direct `child_process` spawn) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Unique public URL generation | decided | A (nanoid) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Video delivery — streaming & download | decided | A (Presigned GET / redirect to storage) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-06 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-07 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-09 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It matches the architecture diagram's "separate queue container", gives the richest job semantics (retries/backoff/stalled recovery/progress) needed for TD-05's failure handling with the least custom code, and has first-class NestJS support that keeps the worker (TD-06) idiomatic. The cost is one Redis container — acceptable for a Docker-Compose dev stack. pg-boss is the strong fallback if avoiding Redis becomes a hard constraint. Candidate versions: `bullmq` ^5, `@nestjs/bullmq` ^11, `redis:7-alpine` (or `valkey`).
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** It is the only option that natively supplies *all three* upload mechanics TD-03 weighs (presigned PUT, presigned POST-policy, and multipart via `lib-storage`/multipart commands) from one maintained SDK, works identically against MinIO (`endpoint` + `forcePathStyle`) and prod S3, and has the deepest documentation. Bucket/key layout convention (single bucket, e.g. `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`) is an implementation detail for `implement`, not a separate TD. Candidate versions: `@aws-sdk/client-s3` ^3, `@aws-sdk/s3-request-presigner` ^3, `@aws-sdk/s3-presigned-post` ^3, `@aws-sdk/lib-storage` ^3; `minio/minio` (latest) image.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** It is the only mechanism that meets the 10GB requirement (single PUT/POST are capped at 5GB), keeps the 10GB bytes entirely off the API (avoiding the auto-fail), and gives resumability + parallelism natively through the AWS SDK already selected in TD-02. Part-size and concurrency are implementation details. tus (Option D) is the fallback if standardized resumable UX later outweighs the extra component. Enforce an upper size bound (10GB) and abort of abandoned multipart uploads.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** The completion of the multipart upload already happens through the backend (TD-03 `CompleteMultipartUpload`), so enqueuing there is a zero-extra-infrastructure, deterministic trigger that keeps the draft lifecycle (TD-05) authoritative and testable. Guard against orphaned uploads with a periodic abort/reconcile of stale multipart sessions (implementation detail). Bucket notifications (Option B) can be added later if a fully client-independent trigger becomes necessary.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** It fulfils the briefing's `draft → processing → ready/error` verbatim, keeps transitions few and testable, and leans on BullMQ (TD-01) for retry/backoff so transient failures don't pollute the status enum; only exhausted retries yield `ERROR`. On failure, the video stays queryable in `ERROR` (no delivery). Extra states (Option B) can be introduced in a later phase if UI observability demands them.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** It honours the architecture's separate-worker model and the performance requirement (FFmpeg isolated from the API) while reusing entities, the storage client (TD-02), and config from the same codebase, avoiding duplication. FFmpeg/ffprobe are installed only in the worker image. This is the standard `@nestjs/bullmq` deployment shape.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** For only two operations (ffprobe metadata + single-frame thumbnail), spawning the binaries directly gives full control with **no dependency on an unmaintained wrapper** (fluent-ffmpeg's maintained path is a fork, a maintenance liability), keeps the footprint minimal, and `ffprobe -print_format json -show_streams -show_format` yields precisely the duration/metadata JSON required. A thin internal wrapper covers spawn/parse/error. `fluent-ffmpeg` (using the maintained fork) is an acceptable fallback if the team prefers its ergonomics. FFmpeg binaries are provided by the worker image (TD-06).
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** It is the standard, right-sized tool for short unique public URLs with a secure default RNG and tunable length; a DB unique constraint (with regenerate-on-conflict) makes collisions a non-issue. Resolve the ESM/CJS interop explicitly at lock time (pin v3 for straightforward CommonJS `require`, or dynamic-import v5). If avoiding any dependency is preferred, Node's built-in `crypto` (Option B, base64url of random bytes) is an equally secure zero-dep fallback. Avoid reversible/enumerable ids (Option C) for public URLs.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** It keeps the API out of the byte path for delivery just as TD-03 does for upload, lets storage serve Range/`206` and downloads natively (download = same signed URL with an attachment `Content-Disposition`), and scales to 10GB files and many concurrent viewers. Short-lived signed URLs provide access control at issue time; expiry is tuned per need. The API-proxy approach (Option B) is the fallback only if per-request authorization or hiding storage URLs becomes a hard requirement — accepting the throughput cost.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs. **Note:** implementation deliberately diverged — custom guards on `@nestjs/jwt` were used instead of `@nestjs/passport` to keep the dependency surface smaller.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI).
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes the frontend can switch on, without RFC 9457's URI overhead. Format `{ statusCode, error, message }` with domain codes; services throw domain exceptions, filters map them to HTTP responses.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- New HTTP endpoints surface errors through the custom domain exception filter — shape `{ statusCode, error, message }` with machine-readable domain codes; services throw domain exceptions, never NestJS HTTP exceptions. _(from phase 02)_
- Request payloads are validated with class-validator DTOs through the global `ValidationPipe`. _(from phase 02)_
- Protected routes are guarded by the global JWT auth guard (custom guards on `@nestjs/jwt`); public routes opt out via the established public decorator. _(from phase 02)_
- Each user owns exactly one channel (1:1, auto-created at signup); channel-owned resources (e.g., videos) resolve ownership from the authenticated user's channel. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` not initialized in that phase; UI surfaces start later. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` not initialized in that phase; UI surfaces start later. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

_(from the `testing-guide-nestjs-project` Skill — artifact → required layers for the artifact types Phase 03 introduces. Read the skill's `artifacts/*.md` for the full recipe per type. Specific layer coverage by SI is recorded in `progress.md`.)_

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`video.entity.ts` — constraints, defaults, unique public-URL index, FK to channel) | Integration (real DB) |
| Service with branching + DB (draft/lifecycle, upload handshake) | Unit (branch logic, mocked repo) + Integration (DB contract) |
| Service with side-effect dep (S3/MinIO storage adapter) | Integration (real local adapter / capture) |
| Queue producer (enqueue processing job) | Integration (queue publishing via `BullModule.registerQueue`) |
| Queue processor / worker (FFmpeg metadata + thumbnail) | Unit (branch/error logic, mocked ffmpeg + storage) + Integration (DB + storage contract) |
| Module with configured imports (`TypeOrmModule.forFeature`, `BullModule.registerQueue`) | Unit (compilation test) |
| Controller (video endpoints: init/complete/stream/download) | E2E only |
| DTOs (upload init/complete payloads) | E2E (one validation-wiring test per endpoint) |
| Exception filter (if a new video-domain filter is added) | Unit + E2E |
