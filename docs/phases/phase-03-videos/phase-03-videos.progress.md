# Phase 03 — Upload e Processamento de Vídeos — Progress

**Status:** in_progress
**SIs:** 3/9 completed

### SI-03.1 — Dependências, Configuração e Docker Compose (Storage + Fila + Worker)
- **Status:** completed
- **Tests:** no tests (infra: deps + config + Compose services)
- **Observations:**
  - Reconciled pre-existing partial work (per user decision): kept `storage.config.ts`, `queue.config.ts`, `worker.ts`, `.env` vars, and the already-installed `nanoid`; filled the remaining gaps.
  - Installed prod deps `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` (^3), `bullmq` (^5), `@nestjs/bullmq` (^11), and saved `nanoid` (^3.3.15, CJS-safe).
  - `compose.yaml`: added `minio`, `minio-init` (bucket bootstrap via `mc`, retry loop, DRY through Compose `${VAR}` substitution from `.env`), `redis` (healthcheck), and `video-worker` (runs `start:worker:dev`). `nestjs-api` + `video-worker` gate on `minio-init: service_completed_successfully` and `redis`/`db` healthy — this replaced an unreliable minio healthcheck.
  - `Dockerfile.dev`: added `ffmpeg` to the shared image → worker has `ffprobe`/`ffmpeg` v5.1.9.
  - `package.json`: added `start:worker`, `start:worker:dev`, `start:worker:prod` scripts.
  - Registered `storageConfig` + `queueConfig` in `AppModule` `ConfigModule.forRoot` load array; extended Joi schema (`STORAGE_BUCKET`, `REDIS_HOST` required) and `.env.example`.
  - Verified: `tsc --noEmit` exit 0; worker boots AppModule ("Video worker started", exit 0); `ffprobe`/`ffmpeg` present; `redis-cli ping` → PONG; bucket `streamtube` exists.
  - Follow-up (out of scope): `npm audit` reports vulnerabilities from aws-sdk transitive deps (17 moderate / 14 high / 1 critical).

### SI-03.2 — Entidade Video e Migração
- **Status:** completed
- **Tests:** 6 passing (5 entity integration + 1 module compile)
- **Observations:**
  - Created `Video` entity: `status` enum (`draft|processing|ready|error`, default `draft`), unique `public_id` varchar(21), `channel_id` (indexed) + `@ManyToOne(Channel)` FK, `bigint size_bytes` via a number transformer (bigint→number, safe under 10GB), `jsonb metadata`, nullable optional fields.
  - Generated `1783020452709-CreateVideos.ts` via CLI (enum `videos_status_enum`, `UNIQUE(public_id)`, `IDX(channel_id)`, FK → `channels`, reversible `down()`); applied via `migration:run`.
  - Created `VideosModule` (`TypeOrmModule.forFeature([Video])`, exports `TypeOrmModule`); registered in `AppModule` so `autoLoadEntities` discovers `Video`.
  - Test isolation: deliberately did NOT add `videos` to the shared `cleanAllTables` — `migrations.integration-spec` drops `channels CASCADE` (dropping `videos`) and only re-runs the 2 baseline migrations, so a shared `DELETE FROM "videos"` would throw "relation does not exist" in other suites. The video entity test cleans `videos` locally (before `cleanAllTables`, respecting FK order).

### SI-03.3 — Adaptador de Object Storage (S3/MinIO)
- **Status:** completed
- **Tests:** 4 passing (3 integration vs real MinIO + 1 module compile)
- **Observations:**
  - `StorageService` wraps `S3Client` (endpoint + `forcePathStyle` from `storageConfig`): `createMultipartUpload`, `presignUploadParts` (presigned PUT per part via `s3-request-presigner`), `completeMultipartUpload` (parts sorted by number → `{ETag,PartNumber}`), `abortMultipartUpload`, `getPresignedGetUrl({ expiresIn, contentDisposition? })` (`ResponseContentDisposition` for attachment downloads).
  - `createMultipartUpload` throws (never swallows) if S3 returns no `UploadId`.
  - `StorageModule` provides + exports `StorageService`; module test provides config via `ConfigModule.forRoot({ isGlobal:true, load:[storageConfig] })`.
  - Integration test drives the full round-trip with `fetch` against the presigned URLs (single small last-part waives the 5MB minimum) and cleans up objects via a raw `S3Client` `DeleteObject` in `afterAll`.
  - APIs cross-checked against AWS SDK v3 docs via context7 before implementing.

### SI-03.4 — Geração de URL Pública Única (nanoid)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.5 — Início de Upload (Pré-cadastro de Rascunho + Init Multipart)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.6 — Conclusão de Upload e Enfileiramento de Processamento
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.7 — Utilitário de Integração FFmpeg (ffprobe + thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.8 — Worker de Processamento de Vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.9 — Entrega de Vídeo (metadados, streaming e download)
- **Status:** pending
- **Tests:** —
- **Observations:** —
