---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-02T11:01:46-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T10:50:56-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete backend video pipeline — object-storage access, automatic draft pre-registration, non-blocking multipart upload of files up to 10GB, automatic background processing (duration/metadata extraction and thumbnail generation via FFmpeg), unique per-video public URLs, and streaming/download delivery — as the media foundation for StreamTube.

---

## Step Implementations

### SI-03.1 — Dependências, Configuração e Docker Compose (Storage + Fila + Worker)

**Description:** Instalar as dependências do pipeline de vídeo, criar os namespaces de configuração de object storage e fila seguindo o padrão `registerAs` da Fase 01, estender o schema Joi, e adicionar os serviços MinIO, Redis e o container worker ao Docker Compose.

**Technical actions:**

1. Instalar dependências de produção em `nestjs-project`: `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `@aws-sdk/lib-storage@^3` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`), `bullmq@^5`, `@nestjs/bullmq@^11` (per `phase-03-videos/TD-01`), `nanoid@^3` (per `phase-03-videos/TD-08`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_FORCE_PATH_STYLE` (bool, default `true` para MinIO), `UPLOAD_MAX_BYTES` (default `10737418240`), `UPLOAD_PART_SIZE` (default `104857600`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-01`)
4. Atualizar `src/config/env.validation.ts` (schema Joi) e `.env.example` com todas as novas variáveis e defaults compatíveis com a rede Docker Compose
5. Adicionar serviços `minio` (per `phase-03-videos/TD-02`), `redis` (per `phase-03-videos/TD-01`) e `video-worker` (mesma imagem, command apontando para o entrypoint do worker, com FFmpeg instalado — per `phase-03-videos/TD-06`) ao `nestjs-project/compose.yaml`, com `nestjs-api` e `video-worker` dependendo de `db`, `minio` e `redis`

**Tests:** _(empty — Infra: instalação de dependências + configuração + serviços de Compose)_

**Dependencies:** none

**Acceptance criteria:**

- A aplicação inicia sem erros quando todas as novas variáveis de ambiente são fornecidas — o teste E2E existente (`GET /` retorna 200) continua passando
- Iniciar a aplicação sem `STORAGE_BUCKET` ou `REDIS_HOST` causa erro de validação Joi no bootstrap — a aplicação não sobe
- Os serviços `minio` e `redis` ficam acessíveis dentro da rede Docker pelos seus nomes de serviço; o bucket configurado em `STORAGE_BUCKET` existe após o start
- O container `video-worker` sobe compartilhando o código e tem os binários `ffmpeg`/`ffprobe` disponíveis (`ffprobe -version` responde dentro do container)

---

### SI-03.2 — Entidade Video e Migração

**Description:** Criar a entidade `Video` com o ciclo de vida de status, o id público único e a relação de posse com o canal, conforme o Data Model, e gerar a migração da tabela `videos`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com todas as colunas do Data Model: `id` (uuid PK), `public_id` (varchar, unique — per `phase-03-videos/TD-08`), `channel_id` (uuid FK → channels), `title`, `original_filename`, `status` (enum `'draft' | 'processing' | 'ready' | 'error'`, default `'draft'` — per `phase-03-videos/TD-05`), `storage_key`, `thumbnail_key` (nullable), `upload_id` (nullable — per `phase-03-videos/TD-03`), `size_bytes` (bigint nullable), `duration_seconds` (int nullable — per `phase-03-videos/TD-07`), `metadata` (jsonb nullable), `error_reason` (text nullable), `created_at`, `updated_at`. Definir `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })` e índice único em `public_id`
2. Gerar a migração via `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL (colunas, enum `videos_status_enum`, unique index em `public_id`, FK para `channels`)
3. Criar `src/videos/videos.module.ts` — `VideosModule` com `TypeOrmModule.forFeature([Video])` nos imports, exportando `TypeOrmModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: `status` default `'draft'`, unique em `public_id`, FK para `channels`, campos nulos aceitos, enum rejeita valor inválido | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: módulo compila com `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, o enum de status, o índice único em `public_id` e a FK para `channels`
- Inserir dois vídeos com o mesmo `public_id` falha por violação de constraint única
- Um vídeo recém-criado sem status explícito assume `status = 'draft'`
- Inserir um vídeo com `status` fora de `{draft, processing, ready, error}` é rejeitado pela constraint de enum

---

### SI-03.3 — Adaptador de Object Storage (S3/MinIO)

**Description:** Encapsular o acesso ao object storage num serviço que fornece as três mecânicas de upload multipart (criar, presignar partes, completar/abortar) e a emissão de URLs GET presignadas para entrega, funcionando de forma idêntica contra MinIO local e S3 de produção.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — `StorageService` injetando `storageConfig`, construindo um `S3Client` com `endpoint` + `forcePathStyle` (per `phase-03-videos/TD-02`). Métodos: `createMultipartUpload(key, contentType)` → `uploadId`; `presignUploadParts(key, uploadId, partCount)` → lista de `{ part_number, url }` (per `phase-03-videos/TD-03`); `completeMultipartUpload(key, uploadId, parts)`; `abortMultipartUpload(key, uploadId)`; `getPresignedGetUrl(key, { expiresIn, contentDisposition? })` → URL GET presignada (per `phase-03-videos/TD-09`)
2. Criar `src/storage/storage.module.ts` — `StorageModule` provendo e exportando `StorageService`, configurado a partir de `storageConfig`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): criar/presignar/completar um multipart upload persiste o objeto; `getPresignedGetUrl` baixa o objeto; `abortMultipartUpload` remove o upload | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: módulo compila e expõe `StorageService` | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Um fluxo completo criar → presignar partes → PUT nas URLs → completar resulta num objeto legível no bucket configurado
- `getPresignedGetUrl` retorna uma URL que baixa o objeto original e, quando `contentDisposition = attachment`, força download
- `abortMultipartUpload` descarta um upload multipart pendente sem deixar objeto no bucket
- O mesmo serviço opera contra MinIO local via `endpoint` + `forcePathStyle` sem alteração de código

---

### SI-03.4 — Geração de URL Pública Única (nanoid)

**Description:** Fornecer um utilitário de geração de id público curto e URL-safe usado como chave das rotas de entrega, com RNG seguro e comprimento fixo — a unicidade final é garantida pela constraint única de `public_id` com regeneração em caso de conflito.

**Technical actions:**

1. Criar `src/videos/public-id.util.ts` — exportar `generatePublicId(): string` usando `nanoid` com alfabeto URL-safe e comprimento fixo (per `phase-03-videos/TD-08`); resolver explicitamente a interop ESM/CJS do nanoid no lock (fixar v3 para `require` CommonJS direto)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: retorna string do comprimento configurado, apenas caracteres URL-safe, sem colisões numa amostra grande | `src/videos/public-id.util.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `generatePublicId()` retorna uma string URL-safe de comprimento fixo a cada chamada
- Duas chamadas consecutivas produzem valores diferentes; uma amostra de 10.000 ids não contém duplicatas
- O valor gerado não contém caracteres que exijam URL-encoding

---

### SI-03.5 — Início de Upload (Pré-cadastro de Rascunho + Init Multipart)

**Description:** Implementar o endpoint de início de upload que pré-cadastra o vídeo como rascunho sob o canal do usuário autenticado, abre o upload multipart no storage e devolve URLs presignadas de parte para o cliente enviar os bytes diretamente ao storage — mantendo os 10GB fora da API.

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload-init.plan.md`

**Technical actions:**

1. Criar `src/videos/dto/init-upload.dto.ts` — `InitUploadDto` com `@IsString() @IsNotEmpty()` `filename`, `@IsString() @IsNotEmpty()` `content_type`, `@IsInt() @IsPositive() @Max(10737418240)` `size_bytes`, `@IsOptional() @IsString()` `title` (per `### API Contracts` → POST /videos, `#### Validation Rules — Upload`)
2. Adicionar `findByOwner(userId: string): Promise<Channel>` ao `ChannelsService` (resolução de posse pertence ao domínio de canais — per convenção herdada da Fase 02) e importar `ChannelsModule` no `VideosModule`
3. Criar `src/videos/videos.service.ts` — `initUpload(userId, dto)`: resolver o canal via `channelsService.findByOwner(userId)`; validar allowlist de `content_type` (lançar `UnsupportedVideoFormatException`); gerar `public_id` via `generatePublicId()` regenerando em colisão; derivar `storage_key = videos/{id}/original.<ext>`; criar o `Video` rascunho (`status = 'draft'`); chamar `storage.createMultipartUpload` + `storage.presignUploadParts`; persistir `upload_id`; retornar `{ id, public_id, status, upload_id, storage_key, part_size, parts }` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
4. Adicionar as subclasses `FileTooLargeException` (413), `UnsupportedVideoFormatException` (415) a `src/common/exceptions/domain.exception.ts` (mesmo padrão da Fase 02); a validação de tamanho > 10GB é rejeitada pelo `@Max` do DTO (400) e reforçada no serviço com `FileTooLargeException` para chamadas fora do pipe
5. Criar `src/videos/videos.controller.ts` — prefixo `'videos'`, `@Post()` chamando `initUpload` com `@CurrentUser()`, retornando 201; registrar `VideosController` + `VideosService` no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initUpload` | Unit: resolve canal, valida formato (throw), gera `public_id`, cria rascunho, chama storage (mocks de repo + storage + channels) | `src/videos/videos.service.spec.ts` |
| `VideosService.initUpload` | Integration: rascunho persistido com `status = 'draft'`, `storage_key` e `upload_id` no banco | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` autenticado com corpo válido retorna 201 com `{ id, public_id, status: 'draft', upload_id, storage_key, part_size, parts }` e cria um rascunho sob o canal do chamador
- `POST /videos` com `size_bytes` acima de 10GB retorna 413 `FILE_TOO_LARGE`
- `POST /videos` com `content_type` fora da allowlist de vídeo retorna 415 `UNSUPPORTED_VIDEO_FORMAT`
- `POST /videos` sem token de acesso retorna 401
- `POST /videos` com corpo inválido (campos faltando) retorna 400 com `error: 'VALIDATION_ERROR'`

---

### SI-03.6 — Conclusão de Upload e Enfileiramento de Processamento

**Description:** Implementar o endpoint de conclusão que finaliza o upload multipart no storage e enfileira o job de processamento — o gatilho determinístico e testável, dono do ciclo de vida do rascunho — transicionando o vídeo de `draft` para `processing`.

**Route:** POST /videos/:id/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` com `@IsArray() @ArrayNotEmpty() @ValidateNested({ each: true })` `parts`, cada item `{ @IsInt() @Min(1) part_number, @IsString() @IsNotEmpty() etag }` (per `### API Contracts` → POST /videos/:id/complete)
2. Registrar a fila `video-processing` via `BullModule.registerQueue({ name: 'video-processing' })` no `VideosModule` e injetar a `Queue` no `VideosService` (per `phase-03-videos/TD-01`)
3. Estender `VideosService` — `completeUpload(userId, videoId, dto)`: carregar o vídeo (`VideoNotFoundException` se ausente; `VideoNotOwnedException` se o canal não for do chamador; `InvalidUploadStateException` se não estiver aguardando conclusão); chamar `storage.completeMultipartUpload`; limpar `upload_id`, gravar `size_bytes`, setar `status = 'processing'`; enfileirar o job `process-video` com `{ videoId, storageKey }`; retornar `{ id, public_id, status: 'processing' }` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
4. Adicionar as subclasses `VideoNotFoundException` (404), `VideoNotOwnedException` (403), `InvalidUploadStateException` (409) a `src/common/exceptions/domain.exception.ts`
5. Adicionar `@Post(':id/complete')` ao `VideosController` com `@CurrentUser()`, retornando 202

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos not-found / not-owner / estado inválido / sucesso enfileira job (mocks de repo, storage, queue) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: `status` vira `'processing'` no banco e o job é publicado na fila (`BullModule.registerQueue`) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/:id/complete` do dono com `parts` válidas retorna 202 com `status: 'processing'` e enfileira exatamente um job `process-video` para aquele vídeo
- `POST /videos/:id/complete` para um `id` inexistente retorna 404 `VIDEO_NOT_FOUND`
- `POST /videos/:id/complete` sobre vídeo de outro canal retorna 403 `VIDEO_NOT_OWNED`
- `POST /videos/:id/complete` sobre vídeo que não está aguardando conclusão retorna 409 `INVALID_UPLOAD_STATE`
- `POST /videos/:id/complete` com `parts` ausente ou malformada retorna 400 com `error: 'VALIDATION_ERROR'`

---

### SI-03.7 — Utilitário de Integração FFmpeg (metadados ffprobe + thumbnail)

**Description:** Encapsular as duas operações de mídia — extração de duração/metadados via `ffprobe` e geração de thumbnail de um frame via `ffmpeg` — num wrapper fino que faz spawn dos binários diretamente, faz parse do JSON e trata erros, sem depender de wrapper não mantido.

**Technical actions:**

1. Criar `src/videos/processing/ffmpeg.util.ts` — `probeMetadata(filePath): Promise<{ durationSeconds, metadata }>` executando `ffprobe -print_format json -show_streams -show_format` via `child_process.spawn` e fazendo parse do JSON (per `phase-03-videos/TD-07`); `extractThumbnail(filePath, outPath): Promise<void>` executando `ffmpeg` para capturar um único frame como JPEG; ambos rejeitando com erro descritivo em exit code não-zero

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ffmpeg.util` | Unit: monta as listas de argumentos corretas e faz parse do JSON do ffprobe em `durationSeconds` + `metadata`; propaga erro em exit não-zero (mock de `child_process`) | `src/videos/processing/ffmpeg.util.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `probeMetadata` retorna a duração em segundos e o subconjunto de metadados a partir da saída JSON do `ffprobe`
- `extractThumbnail` produz um arquivo JPEG de um único frame no caminho de saída informado
- Uma falha de execução (exit code não-zero) de qualquer binário resulta em rejeição da Promise com mensagem de erro, não em resolução silenciosa

---

### SI-03.8 — Worker de Processamento de Vídeo

**Description:** Implementar o processor BullMQ que consome os jobs `process-video` no container worker isolado, baixa o original do storage, extrai duração/metadados e gera a thumbnail via FFmpeg, sobe a thumbnail e transiciona o vídeo para `ready` — ou para `error` após esgotar as retries.

**Technical actions:**

1. Criar `src/videos/processing/video.processor.ts` — `@Processor('video-processing')` `VideoProcessingWorker`: baixar o original (`storageKey`) para um arquivo temporário via `StorageService`; chamar `probeMetadata` → `duration_seconds` + `metadata`; chamar `extractThumbnail` e subir o resultado em `thumbnail_key = videos/{id}/thumbnail.jpg`; atualizar o `Video` para `status = 'ready'` com os campos preenchidos; limpar os arquivos temporários (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`, `phase-03-videos/TD-02`)
2. Configurar as opções do job/worker com retries + backoff exponencial no registro da fila; no callback de falha final (retries esgotadas), setar `status = 'error'` e `error_reason` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`)
3. Registrar `VideoProcessingWorker` nos providers do `VideosModule`, disponível ao entrypoint do container `video-worker` (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingWorker` | Unit: sucesso → `ready` com duração + `thumbnail_key`; erro do FFmpeg → propaga para retry; falha final → `error` + `error_reason` (mocks de storage, ffmpeg util, repo) | `src/videos/processing/video.processor.spec.ts` |
| `VideoProcessingWorker` | Integration: dado um arquivo de vídeo pequeno no storage, processa até `ready` persistindo `duration_seconds`, `metadata` e `thumbnail_key` | `src/videos/processing/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.6, SI-03.7

**Acceptance criteria:**

- Ao processar um vídeo cujo upload foi concluído, o worker persiste `status = 'ready'`, `duration_seconds` e `thumbnail_key`, e a thumbnail fica acessível no storage
- Uma falha transitória do processamento é reexecutada conforme a política de retry/backoff, sem transicionar imediatamente para `error`
- Após esgotar as retries, o vídeo fica em `status = 'error'` com `error_reason` preenchido e permanece consultável (sem entrega)

---

### SI-03.9 — Entrega de Vídeo (metadados, streaming e download)

**Description:** Implementar as rotas públicas de entrega keyadas pelo `public_id` — leitura de metadados/status, streaming e download — emitindo URLs GET presignadas de curta duração e redirecionando, mantendo a API fora do caminho dos bytes; o storage serve `Range`/`206` nativamente e apenas vídeos `ready` são entregues.

**Route:** GET /videos/:publicId, GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`

**Technical actions:**

1. Estender `VideosService` — `getPublicView(publicId)`: buscar por `public_id` (`VideoNotFoundException` se ausente); retornar `{ public_id, title, status, duration_seconds, thumbnail_url, created_at }`, onde `thumbnail_url` é uma URL GET presignada de curta duração para `thumbnail_key` (ou `null` até processar) (per `phase-03-videos/TD-09`)
2. Estender `VideosService` — `getDeliveryUrl(publicId, { disposition })`: buscar por `public_id` (`VideoNotFoundException`); se `status !== 'ready'` lançar `VideoNotReadyException` (409); retornar URL GET presignada para `storage_key`, com `Content-Disposition: attachment` quando `disposition = 'attachment'` (per `phase-03-videos/TD-09`)
3. Adicionar a subclasse `VideoNotReadyException` (409) a `src/common/exceptions/domain.exception.ts`
4. Adicionar ao `VideosController`, todos `@Public()`: `@Get(':publicId')` → 200 com a view; `@Get(':publicId/stream')` → `res.redirect(302, url)`; `@Get(':publicId/download')` → `res.redirect(302, url)` com disposition `attachment`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPublicView` / `getDeliveryUrl` | Unit: not-found lança 404; `status !== 'ready'` lança 409 na entrega; sucesso retorna URL presignada (mocks de repo + storage) | `src/videos/videos.service.spec.ts` |
| `VideosService` (entrega) | Integration: view retorna metadados por `public_id`; entrega de vídeo `ready` produz URL presignada funcional | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.8

**Acceptance criteria:**

- `GET /videos/:publicId` retorna 200 com `{ public_id, title, status, duration_seconds, thumbnail_url, created_at }` para um `public_id` existente, sem autenticação
- `GET /videos/:publicId` para um `public_id` inexistente retorna 404 `VIDEO_NOT_FOUND`
- `GET /videos/:publicId/stream` de um vídeo `ready` retorna 302 com `Location` apontando para uma URL GET presignada de curta duração
- `GET /videos/:publicId/download` de um vídeo `ready` retorna 302 para uma URL presignada com `Content-Disposition: attachment`
- `GET /videos/:publicId/stream` ou `/download` de um vídeo cujo `status` não é `ready` retorna 409 `VIDEO_NOT_READY`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; used by owner-only management endpoints |
| public_id | varchar(21) | unique, not null | Short unique public URL id generated with nanoid (per `phase-03-videos/TD-08`) — keys all delivery endpoints |
| channel_id | uuid | FK → channels.id, not null | Owning channel; resolved from the authenticated user's channel (inherited convention, phase 02) |
| title | varchar(255) | not null | Provided at upload init; defaults to the original filename when omitted |
| original_filename | varchar(255) | not null | Client-supplied filename captured at init |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'error'` | Lifecycle per `phase-03-videos/TD-05` (`draft → processing → ready/error`) |
| storage_key | varchar | not null | Object key of the original file, `videos/{id}/original.<ext>` (per `phase-03-videos/TD-02`) |
| thumbnail_key | varchar | nullable | Object key of the generated thumbnail, `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`); set after processing |
| upload_id | varchar | nullable | S3/MinIO multipart `UploadId` (per `phase-03-videos/TD-03`); set at init, cleared after `CompleteMultipartUpload` |
| size_bytes | bigint | nullable | Final object size; populated after upload completion |
| duration_seconds | int | nullable | Extracted by ffprobe (per `phase-03-videos/TD-07`); set after processing |
| metadata | jsonb | nullable | Raw probe output subset (streams/format) from ffprobe (per `phase-03-videos/TD-07`) |
| error_reason | text | nullable | Failure detail when `status = 'error'` after exhausted retries (per `phase-03-videos/TD-05`) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one; a channel owns many videos)
**Indexes:** `(public_id)` — unique (collision-safe public URL, regenerate-on-conflict per `phase-03-videos/TD-08`), `(channel_id)` — FK

---

### API Contracts

#### POST /videos (SI-03.5)

Initiates an upload: creates the draft Video under the caller's channel, opens an S3/MinIO multipart upload, and returns presigned part URLs the client uploads directly to storage (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — original filename (extension derives `storage_key`; also the default title)
- content_type: string, required — video MIME type from the supported allowlist
- size_bytes: integer, required — total file size in bytes; must be ≤ 10737418240 (10GB)
- title: string, optional — defaults to `filename` when omitted

**Response 201:**
- id: string (uuid)
- public_id: string
- status: string — `'draft'`
- upload_id: string — S3/MinIO multipart `UploadId`
- storage_key: string
- part_size: integer — bytes per part the client must use
- parts: array of `{ part_number: integer, url: string }` — presigned PUT URLs, one per part

**Error responses:**
- 413 FILE_TOO_LARGE: when `size_bytes` exceeds the 10GB limit
- 415 UNSUPPORTED_VIDEO_FORMAT: when `content_type` is not a supported video MIME type
- 401: when the access token is missing or invalid
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/complete (SI-03.6)

Finalizes the multipart upload (`CompleteMultipartUpload`) and enqueues the processing job — the deterministic, backend-owned trigger (per `phase-03-videos/TD-04`). Transitions the video `draft → processing`.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Path parameters:**
- id: string (uuid), required — the draft video id returned by `POST /videos`

**Request body:**
- parts: array, required — `[{ part_number: integer, etag: string }]`, one entry per uploaded part as returned by storage

**Response 202:**
- id: string (uuid)
- public_id: string
- status: string — `'processing'`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with this id exists
- 403 VIDEO_NOT_OWNED: when the video belongs to another channel
- 409 INVALID_UPLOAD_STATE: when the video is not awaiting completion (already processing, ready, or error)
- 401: when the access token is missing or invalid
- 400 validation error: when `parts` is missing or malformed

---

#### GET /videos/:publicId (SI-03.9)

Public read of a video's status and metadata — keyed by the unique `public_id` (per `phase-03-videos/TD-08`). Used by clients to poll processing status and render metadata.

**Path parameters:**
- publicId: string, required — the video's `public_id`

**Response 200:**
- public_id: string
- title: string
- status: string — one of `'draft'`, `'processing'`, `'ready'`, `'error'`
- duration_seconds: integer | null — populated once `status = 'ready'`
- thumbnail_url: string | null — short-lived presigned GET URL to the thumbnail, or null until processed
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id`

---

#### GET /videos/:publicId/stream (SI-03.9)

Streaming delivery — issues a short-lived presigned GET URL and redirects; storage serves `Range` / `206` natively, keeping the API off the byte path (per `phase-03-videos/TD-09`). Only `ready` videos are delivered.

**Path parameters:**
- publicId: string, required — the video's `public_id`

**Response 302:** Redirect. `Location` is a short-lived presigned GET URL to the original object.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id`
- 409 VIDEO_NOT_READY: when `status` is not `'ready'`

---

#### GET /videos/:publicId/download (SI-03.9)

Download delivery — same presigned-redirect mechanism as streaming, with the signed URL carrying an attachment `Content-Disposition` (per `phase-03-videos/TD-09`). Only `ready` videos are delivered.

**Path parameters:**
- publicId: string, required — the video's `public_id`

**Response 302:** Redirect. `Location` is a short-lived presigned GET URL with `response-content-disposition=attachment`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has this `public_id`
- 409 VIDEO_NOT_READY: when `status` is not `'ready'`

#### Validation Rules — Upload

| Field | Rule |
|-------|------|
| filename | required, non-empty string |
| content_type | required; must be in the supported video MIME allowlist (else 415 UNSUPPORTED_VIDEO_FORMAT) |
| size_bytes | required, integer > 0, ≤ 10737418240 (10GB) (else 413 FILE_TOO_LARGE) |
| parts | required non-empty array; each item `{ part_number ≥ 1, etag non-empty }` |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner | Notes |
|----------|--------|---------------|-------|-------|
| POST /videos | | ✓ | | Draft is created under the caller's own channel |
| POST /videos/:id/complete | | | ✓ | Caller must own the draft video (403 otherwise) |
| GET /videos/:publicId | ✓ | | | Anonymous read of status/metadata |
| GET /videos/:publicId/stream | ✓ | | | Anonymous watch; only `ready` videos are delivered |
| GET /videos/:publicId/download | ✓ | | | Anonymous download; only `ready` videos are delivered |

---

### Error Catalog

**Error response format:** inherited from phase 02 — `{ statusCode, error, message }`, where `error` carries the domain code below and validation failures use `error: 'VALIDATION_ERROR'`. Domain exceptions are mapped by the shared domain exception filter (per `## Inherited Conventions`).

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | GET metadata/stream/download or complete with an unknown id/`public_id` |
| VIDEO_NOT_OWNED | 403 | You do not own this video | POST /videos/:id/complete on a video owned by another channel |
| INVALID_UPLOAD_STATE | 409 | Upload is not awaiting completion | POST /videos/:id/complete when the video is not in the awaiting-completion state |
| VIDEO_NOT_READY | 409 | Video is not ready for delivery | GET /videos/:publicId/stream or /download when `status` is not `'ready'` |
| FILE_TOO_LARGE | 413 | File exceeds the 10GB limit | POST /videos with `size_bytes` greater than 10GB |
| UNSUPPORTED_VIDEO_FORMAT | 415 | Unsupported video format | POST /videos with a `content_type` outside the supported video MIME allowlist |

---

### Events/Messages

#### process-video (queue `video-processing`)

BullMQ job on Redis (per `phase-03-videos/TD-01`), consumed by an isolated FFmpeg worker (per `phase-03-videos/TD-06`).

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "videos/{id}/original.<ext>" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-04`) — enqueues immediately after a successful `CompleteMultipartUpload` (SI-03.6)
**Consumer:** `VideoProcessingWorker` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`) — downloads the original, runs `ffprobe` for duration/metadata and extracts a single-frame thumbnail via `ffmpeg`, uploads the thumbnail, and updates the Video row to `ready` (or `error` on exhausted retries)
**Trigger:** fires once per video when its multipart upload is completed (per `phase-03-videos/TD-04`)
**Delivery semantics:** at-least-once with retries + exponential backoff; only exhausted retries transition the video to `status = 'error'`, keeping transient failures out of the status enum (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`)

---

## Dependency Map

```
SI-03.1 (root — deps, config, compose)
├── SI-03.2 — depends on SI-03.1 (Video entity + migração)
├── SI-03.3 — depends on SI-03.1 (adaptador de storage)
├── SI-03.4 — depends on SI-03.1 (util de public_id)
└── SI-03.7 — depends on SI-03.1 (util FFmpeg)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 — início de upload (POST /videos)
    └── SI-03.6 — conclusão + enfileiramento (POST /videos/:id/complete)

SI-03.3 + SI-03.6 + SI-03.7
└── SI-03.8 — worker de processamento

SI-03.5 + SI-03.8
└── SI-03.9 — entrega (GET metadados/stream/download)
```

Ordem linearizada de implementação: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.7 (paralelos) → SI-03.5 → SI-03.6 → SI-03.8 → SI-03.9

---

## Deliverables

- [ ] SI-03.1 — Dependências, configuração e Docker Compose (Storage + Fila + Worker)
- [ ] SI-03.2 — Entidade `Video` e migração
- [ ] SI-03.3 — Adaptador de object storage (S3/MinIO)
- [ ] SI-03.4 — Geração de URL pública única (nanoid)
- [ ] SI-03.5 — Início de upload (pré-cadastro de rascunho + init multipart) — `POST /videos`
- [ ] SI-03.6 — Conclusão de upload e enfileiramento de processamento — `POST /videos/:id/complete`
- [ ] SI-03.7 — Utilitário de integração FFmpeg (ffprobe + thumbnail)
- [ ] SI-03.8 — Worker de processamento de vídeo
- [ ] SI-03.9 — Entrega de vídeo (metadados, streaming e download)

**Capacidades entregues:**

- [ ] Upload de arquivos de até 10GB sem impacto na performance (multipart presignado, bytes fora da API)
- [ ] Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- [ ] Processamento automático após upload — extração de duração e metadados via ffprobe
- [ ] Geração automática de thumbnail a partir de um frame do vídeo
- [ ] URL única por vídeo (`public_id`), sem conflito com outros vídeos
- [ ] Reprodução via streaming (redirect para URL presignada; `Range`/`206` servido pelo storage)
- [ ] Download do vídeo pelo usuário (URL presignada com `Content-Disposition: attachment`)
- [ ] Serviço de object storage (vídeos e thumbnails) e serviço de processamento em fila operacionais

**Full test suites:**

- [ ] Testes de unidade + integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Projeto compila (`docker compose exec nestjs-api npm run build`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
