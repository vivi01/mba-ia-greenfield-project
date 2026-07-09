---
libs:
  bullmq:
    version: "^5.79.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-03T00:00:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-03T00:00:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1079.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-03T00:00:00-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.1079.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-03T00:00:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1079.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-03T00:00:00-03:00"
  nanoid:
    version: "^3.3.15"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-03T00:00:00-03:00"
  ffmpeg:
    version: "system 5.1.x (ffmpeg + ffprobe, worker image)"
    context7_id: "n/a — system binaries, spawned via node:child_process"
    fetched_at: "2026-07-03T00:00:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T00:00:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this slice. Pulled via Context7 and
pinned to what actually installs on NestJS 11 / Node 22. Versions are the pins in
`nestjs-project/package.json`. Re-fetch when the underlying TD changes.

## BullMQ + @nestjs/bullmq

**Source:** `/taskforcesh/bullmq` and `/nestjs/bull` (Context7) — High reputation.
Maps to `phase-03-videos/TD-01` (queue technology) Decision A and `TD-06`
(worker deployment model) Decision A.

### How it is used

- `BullModule.forRoot({ connection })` registers the Redis connection; the
  connection host is the Compose service name `redis` (never `localhost`).
- `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions })`
  declares the `video-processing` queue with `attempts: 3` and
  `backoff: { type: 'exponential', delay: PROCESS_VIDEO_BACKOFF_MS }`.
- The producer side injects the queue and calls `queue.add(PROCESS_VIDEO_JOB, data)`
  on upload completion (`videos.service.ts`).
- The consumer is a class extending `WorkerHost`, decorated with
  `@Processor(VIDEO_PROCESSING_QUEUE)`, implementing `process(job)`. Failure
  handling uses `@OnWorkerEvent('failed')` — the row is only moved to `error`
  once `job.attemptsMade` reaches the configured `attempts`, so retries are not
  reported as permanent failures.
- **Worker isolation (TD-06):** the `WorkerHost` provider is registered only when
  `process.env.VIDEO_WORKER === 'true'`, so the API process never spawns FFmpeg;
  the dedicated `video-worker` container runs the same image with that flag set.

### Gotcha

BullMQ keeps ioredis connections open, which prevents Jest from exiting cleanly.
The test scripts run with `--forceExit`.

## AWS SDK v3 — S3 client (MinIO)

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation, first-class
TypeScript. Maps to `phase-03-videos/TD-02` (object storage client) Decision A,
`TD-03` (large-file upload), and `TD-09` (delivery).

### How it is used

`StorageService` (`src/storage/storage.service.ts`) wraps a single `S3Client`
configured for MinIO: `endpoint` = the `minio` Compose service, `forcePathStyle: true`,
static credentials from `storage.config.ts`.

- **Presigned upload/download** — `@aws-sdk/s3-request-presigner`'s
  `getSignedUrl(client, command, { expiresIn })` with `PutObjectCommand` (upload
  handshake) and `GetObjectCommand` (streaming / download). Download passes
  `ResponseContentDisposition: 'attachment'`.
- **Large uploads** — `@aws-sdk/lib-storage`'s `Upload` performs multipart uploads
  so 10GB files transfer without buffering in the API process.
- **Worker helpers** — `downloadToFile(key, destPath)` streams a `GetObjectCommand`
  body to a temp file via `node:stream/promises` `pipeline` and returns the byte
  size; `putObject(key, buffer, contentType)` uploads the generated thumbnail.

## nanoid

**Source:** `/ai/nanoid` (Context7) — High reputation. Maps to
`phase-03-videos/TD-08` (unique public URL) Decision A.

Pinned to **v3** (`^3.3.15`) — the CommonJS line — because the project's Jest /
ts-jest setup consumes CJS; nanoid v4+ is ESM-only. `nanoid()` produces the
21-char URL-safe `public_id` stored on the video and used in every public route
(`GET /videos/:publicId`). The column has a unique constraint so a collision
surfaces as a DB error rather than a silent overwrite.

## FFmpeg / ffprobe (system binaries)

**Source:** n/a (CLI tool, not an npm library). Maps to `phase-03-videos/TD-07`
(FFmpeg integration) Decision A — **direct `child_process` spawn**, no
`fluent-ffmpeg` wrapper (the maintained variant is a community fork; a wrapper
adds risk over what is ultimately a CLI).

`src/videos/processing/ffmpeg.util.ts` spawns the binaries directly:

- `probeMetadata(file)` runs `ffprobe -v error -print_format json -show_streams
  -show_format`, parses JSON, and returns `{ durationSeconds, metadata }`.
- `extractThumbnail(file, out)` runs `ffmpeg -y -i <file> -frames:v 1 -q:v 2 <out>`.

Both reject on non-zero exit or spawn error. FFmpeg is installed **only** in the
worker image (TD-06).
