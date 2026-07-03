# Phase 03 — Upload e Processamento de Vídeos — Progress

**Status:** in_progress
**SIs:** 8/9 completed

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
- **Status:** completed
- **Tests:** 4 passing (unit)
- **Observations:**
  - `generatePublicId()` uses nanoid's secure default RNG + URL-safe alphabet (`A-Za-z0-9_-`), fixed length `PUBLIC_ID_LENGTH = 21` (matches `videos.public_id` varchar(21)). Final uniqueness enforced by the DB unique constraint + regenerate-on-conflict (SI-03.5).
  - nanoid pinned to v3 (CommonJS-compatible); import verified under the project's CommonJS build — `tsc --noEmit` clean and the unit test runs.
  - Incidental fix: SI-03.3's `storage.service.integration-spec.ts` passed `Buffer` to `fetch` (runtime-OK via undici, but `tsc` rejects `Buffer` as `BodyInit`). Switched to `Uint8Array`/`TextEncoder` so `tsc --noEmit` is clean (DoD).

### SI-03.5 — Início de Upload (Pré-cadastro de Rascunho + Init Multipart)
- **Status:** completed
- **Tests:** 11 passing (5 unit + 1 integration + 5 E2E)
- **Observations:**
  - `POST /videos` (`VideosController`, `@ApiBearerAuth`, `@HttpCode(201)`) → `VideosService.initUpload(userId, dto)`: resolve o canal via `channelsService.findByOwner`, valida a allowlist de `content_type`, gera `public_id`, deriva `storage_key = videos/{id}/original.<ext>` (id pré-gerado com `randomUUID()` para compor a key antes do insert), persiste o rascunho (`status='draft'`), abre o multipart (`createMultipartUpload` + `presignUploadParts`, `partCount = ceil(size/part_size)`), grava `upload_id` e retorna `{ id, public_id, status, upload_id, storage_key, part_size, parts }`.
  - **Desvio deliberado do plano (Action 1 vs AC #2 / test 1.2):** o plano lista `@Max(10737418240)` no DTO, mas isso rejeitaria o caso "1 byte acima de 10GB" como **400 VALIDATION_ERROR**, enquanto a AC #2 e o test spec `videos-upload-init.plan.md §1.2` exigem **413 FILE_TOO_LARGE**. Resolvi a favor da AC/test (autoritativos): o `@Max` foi **omitido** do DTO (mantidos `@IsInt`/`@IsPositive` para o 400 de corpo inválido) e o teto de 10GB é imposto no serviço via `FileTooLargeException` (413), lendo `storageConfig.uploadMaxBytes`. Vale revisar o texto da Action 1 do plano para refletir isso.
  - `ChannelsService.findByOwner(userId): Promise<Channel>` adicionado (resolução de posse pertence ao domínio de canais); lança `Error` genérico se ausente — invariante (todo usuário tem exatamente um canal, criado no registro via `UsersService.createUserWithChannel`). `VideosModule` passou a importar `ChannelsModule` (exporta `ChannelsService`) e `StorageModule` (exporta `StorageService`); registrados `VideosController` + `VideosService`.
  - Allowlist de MIME em `src/videos/videos.constants.ts` (`SUPPORTED_VIDEO_MIME_TYPES` como `readonly string[]` para o `.includes` type-checar); regenera `public_id` em colisão via helper local `isPgUniqueViolationOnColumn` (mesmo padrão do `ChannelsService`, `MAX_PUBLIC_ID_RETRIES=5`). `size_bytes` NÃO é persistido no init (Data Model: preenchido só na conclusão — SI-03.6).
  - Novas exceções de domínio `FileTooLargeException` (413) e `UnsupportedVideoFormatException` (415) em `domain.exception.ts`, mapeadas pelo `DomainExceptionFilter` existente (shape genérico via `httpStatus`/`errorCode`).
  - Testes de serviço construídos manualmente (mock repo/storage/channels no unit; `new VideosService(...)` + `storageConfig()` no integration, espelhando `channels.service.integration-spec.ts`). O integration e o E2E abrem multipart uploads reais no MinIO e os **abortam no `afterAll`** para não deixar uploads pendentes.
  - E2E: o `beforeAll`/`afterAll` receberam timeout explícito de `60_000ms` — o cold-compile do `AppModule` via ts-jest sob o bind mount lento do Windows estourava o default de 5s do Jest (era timeout de hook, não falha de asserção).

### SI-03.6 — Conclusão de Upload e Enfileiramento de Processamento
- **Status:** completed
- **Tests:** 16 passing (9 unit + 2 integration + 5 E2E)
- **Observations:**
  - `POST /videos/:id/complete` (`@HttpCode(202)`, `@Param('id', ParseUUIDPipe)`) → `VideosService.completeUpload(userId, videoId, dto)`: carrega o vídeo (`VideoNotFoundException`), resolve o canal do chamador e compara (`VideoNotOwnedException`), exige `status='draft'` + `upload_id` presente (`InvalidUploadStateException`), chama `storage.completeMultipartUpload`, limpa `upload_id`, seta `status='processing'`, persiste e enfileira **um** job `process-video` com `{ videoId, storageKey }`.
  - **BullMQ (primeira fila do projeto):** `BullModule.forRootAsync` registrado no `AppModule` (conexão Redis a partir de `queueConfig` — cobre API e o container worker, ambos bootam `AppModule`); `BullModule.registerQueue({ name: 'video-processing' })` no `VideosModule`; `@InjectQueue(VIDEO_PROCESSING_QUEUE)` no `VideosService`. Nomes de fila/job centralizados em `videos.constants.ts` (`VIDEO_PROCESSING_QUEUE`, `PROCESS_VIDEO_JOB`). APIs conferidas via context7 (`@nestjs/bullmq`) antes de implementar. Retry/backoff (`defaultJobOptions`) ficam para SI-03.8 conforme o plano.
  - `CompleteUploadDto`: `parts` `@IsArray @ArrayNotEmpty @ValidateNested({each:true}) @Type(() => CompletedPartDto)`, cada item `{ @IsInt @Min(1) part_number, @IsString @IsNotEmpty etag }`. `ParseUUIDPipe` no path → id malformado vira 400 VALIDATION_ERROR (via `ValidationExceptionFilter`).
  - Exceções `VideoNotFoundException` (404), `VideoNotOwnedException` (403), `InvalidUploadStateException` (409) adicionadas a `domain.exception.ts`.
  - **Desvio do plano (Action 3 — `size_bytes`):** o plano pede "gravar `size_bytes`" na conclusão, mas nem a resposta do `CompleteMultipartUpload` nem o `StorageService` (SI-03.3) expõem o tamanho do objeto neste ponto, e estender o adaptador de storage está fora do escopo desta SI. Nenhum teste/AC de SI-03.6 exige `size_bytes`. **Adiado para SI-03.8**, onde o worker baixa o original e pode derivar `size_bytes` do arquivo junto com duração/metadados. Deixar isso explícito para a próxima SI.
  - Testes: unit cobre os 4 ramos de `completeUpload` (mocks de repo/storage/channels/queue via `getQueueToken`); integration usa `Queue` real (Redis) + round-trip real de multipart (init → PUT presignado com `Uint8Array` → complete) e assere `status='processing'`/`upload_id=null` no banco + job publicado; E2E cobre os 5 cenários do spec. Hooks `beforeAll/afterAll` dos specs de integração/E2E receberam timeout de `60_000ms` (cold-compile do ts-jest sob o bind mount lento estoura o default de 5s). Filas são limpas com `queue.obliterate({force:true})` entre testes; o container `video-worker` ainda não tem `@Processor` (SI-03.8), então nenhum consumidor drena os jobs durante os testes.

### SI-03.7 — Utilitário de Integração FFmpeg (ffprobe + thumbnail)
- **Status:** completed
- **Tests:** 7 passing (unit)
- **Observations:**
  - `src/videos/processing/ffmpeg.util.ts` — wrapper fino que faz `spawn` direto dos binários (per `TD-07`, sem `fluent-ffmpeg`). Helper interno `runBinary(command, args)` bufferiza stdout/stderr e resolve com stdout em exit 0; **rejeita** (nunca resolve silenciosamente — per `.claude/rules/nestjs-services.md`) em exit não-zero (mensagem `<bin> exited with code N: <stderr>`) e no evento `error` do processo (binário ausente → `Failed to spawn <bin>: ...`).
  - `probeMetadata(filePath)` → `ffprobe -v error -print_format json -show_streams -show_format <file>`, `JSON.parse` da saída; `durationSeconds = Math.round(parseFloat(format.duration)) || 0` (int, casa com a coluna `duration_seconds`; default 0 quando ausente/NaN); `metadata = { format, streams }` (subconjunto cru do probe per Data Model). Tipos `ProbeResult`/`ProbeMetadata` exportados.
  - `extractThumbnail(filePath, outPath)` → `ffmpeg -y -i <file> -frames:v 1 -q:v 2 <out>` (frame único, JPEG de alta qualidade); resolve `void` em exit 0.
  - `child_process` é módulo core do Node → sem lookup context7 (mandato aplica-se a libs). Teste unit mocka `node:child_process` (`jest.mock` + `spawn` fake baseado em `EventEmitter` com `stdout`/`stderr`): assere as listas de argumentos de ambos os binários, o parse do JSON em `durationSeconds`+`metadata`, o default de duração, e a propagação de erro em exit não-zero e em falha de spawn.
  - SI unit-only legado (sem `**Test Specs:**`) → nenhum E2E autorado. `tsc --noEmit` exit 0.

### SI-03.8 — Worker de Processamento de Vídeo
- **Status:** completed
- **Tests:** 7 passing (5 unit + 1 integration + 1 module compile) — o `ffmpeg.util.spec.ts` (7, da SI-03.7) continua verde
- **Observations:**
  - `src/videos/processing/video.processor.ts` — `@Processor('video-processing')` `VideoProcessingWorker extends WorkerHost`; `process(job)`: `mkdtemp` → `storage.downloadToFile` → `probeMetadata` → `extractThumbnail` → `readFile` + `storage.putObject(thumbnailKey(id), buf, 'image/jpeg')` → carrega o vídeo e persiste `status='ready'` + `duration_seconds`/`metadata`/`thumbnail_key`/`size_bytes`; `finally` remove o `workDir`. Erros de FFmpeg/storage **propagam** (retry do BullMQ).
  - **`@OnWorkerEvent('failed')` `onFailed(job, error)`**: só transiciona para `status='error'` + `error_reason` quando `job.attemptsMade >= (job.opts.attempts ?? PROCESS_VIDEO_MAX_ATTEMPTS)` — falhas transitórias ficam fora do enum de status (per `TD-01`/`TD-05`). Nunca relança (handler de evento; per `.claude/rules/nestjs-services.md`), erro de update é logado.
  - **StorageService estendido** (necessário pelo worker, referenciado pela Action 1): `downloadToFile(key, destPath)` faz streaming do `GetObject` para arquivo via `stream/promises.pipeline` e **retorna `ContentLength`** — é daqui que sai o **`size_bytes`** (resolve o carry-over adiado na SI-03.6); `putObject(key, body, contentType)` sobe a thumbnail. Aditivo, sem quebrar os testes existentes do storage.
  - **Retry/backoff (carry-over da SI-03.6):** `BullModule.registerQueue` no `VideosModule` ganhou `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` (constantes `PROCESS_VIDEO_MAX_ATTEMPTS`/`PROCESS_VIDEO_BACKOFF_MS`). Confirmado via context7 (`@nestjs/bullmq` + `bullmq`).
  - **Nota de arquitetura:** API e worker bootam o mesmo `AppModule`, então o `@Processor` registrado nos providers do `VideosModule` roda em **ambos** os containers (consumidores concorrentes do BullMQ — jobs processados uma vez; ambos têm ffmpeg na imagem compartilhada). Segue o plano (Action 3 pede registro simples no `VideosModule`); a isolação por container é nominal. `.compile()` não dispara o `BullExplorer` (onApplicationBootstrap), então o teste de módulo não inicia worker real.
  - **jsonb via load-mutate-save:** o `process` carrega o vídeo e atribui `metadata` direto (em vez de `repository.update`) — o `QueryDeepPartialEntity` do TypeORM não aceita `Record<string, unknown>` num campo jsonb no `.update()`. `onFailed` (sem jsonb) continua usando `update`.
  - **Correção do `videos.module.spec.ts`:** o teste de compilação não provia `storageConfig`/`queueConfig` nem conexão Bull (gap pré-existente desde a SI-03.5, quando `StorageModule`/`VideosService` entraram — a instância eager do `StorageService` exige `CONFIGURATION(storage)`). Adicionados `ConfigModule.forRoot({ load: [storageConfig, queueConfig] })` + `BullModule.forRoot({ connection })`; passa a compilar todo o grafo (serviço + processor + fila).
  - Teste de integração gera um clipe real de 1s via `ffmpeg -f lavfi -i testsrc` (o binário está na imagem compartilhada, presente também no `nestjs-api`), sobe o original no MinIO, roda `worker.process` e assere `ready`/`duration_seconds≥1`/`size_bytes>0`/`thumbnail_key` + thumbnail baixável. Hooks `beforeAll/afterAll` com timeout `60_000`; objetos limpos via `S3Client` cru no `afterAll`.
  - Ruído `ECONNREFUSED 127.0.0.1:6379` pós-teste vem de conexões Bull residuais em specs sem `forRoot`; não afeta asserções (jobs não são drenados — sem `@Processor` ativo nos testes de serviço).

### SI-03.9 — Entrega de Vídeo (metadados, streaming e download)
- **Status:** pending
- **Tests:** —
- **Observations:** —
