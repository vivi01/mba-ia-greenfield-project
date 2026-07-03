# StreamTube — Backend (API NestJS)

API da plataforma de compartilhamento de vídeos **StreamTube**, construída com
**NestJS 11 + TypeScript + TypeORM + PostgreSQL 17**. Responsável por
autenticação, canais, upload/processamento/entrega de vídeos, envio de e-mails
transacionais e publicação de jobs na fila de processamento.

> Visão geral do projeto (monorepo, frontend, arquitetura C4) no
> [README raiz](../README.md). Planejamento e decisões em [`docs/`](../docs).

## Módulos

| Módulo | Responsabilidade |
|--------|------------------|
| `auth` | Cadastro, confirmação de e-mail, login, rotação de refresh token, reset de senha (JWT + Argon2) |
| `users` | Entidade e serviço de usuários |
| `channels` | Canal 1:1 por usuário (criado no cadastro) — dono dos vídeos |
| `videos` | **Fase 03** — upload, ciclo de vida, processamento e entrega de vídeos |
| `storage` | Adaptador de object storage S3/MinIO (multipart + URLs pré-assinadas) |
| `mail` | E-mails transacionais (templates Handlebars) via SMTP/Mailpit |
| `common` | Filtros, pipes e exceptions de domínio compartilhados |
| `config` | Configs namespaced validadas com Joi |
| `database` | `data-source`, migrations e seeds |
| `swagger` | Documento OpenAPI exposto em `/api/docs` |

## Pré-requisitos

- Docker e Docker Compose

Todos os comandos `npm`/`npx`/`tsc`/testes rodam **dentro do container**, nunca no
host (evita divergência de variáveis de ambiente e versão do Node).

## Como rodar

```bash
cd nestjs-project

# Sobe a infraestrutura: API (idle), PostgreSQL, Mailpit, MinIO (+bootstrap do
# bucket), Redis e o worker de vídeo.
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor da API em watch mode.
# (o compose deixa a API ociosa por padrão; o servidor não sobe sozinho)
docker compose exec -d nestjs-api npm run start:dev
```

O `video-worker` já sobe processando a fila (`command: npm run start:worker:dev`);
não é preciso iniciá-lo manualmente.

### Serviços

| Serviço | URL / Porta | Observação |
|---------|-------------|------------|
| API NestJS | http://localhost:3000 | servidor sobe via `start:dev` |
| Video Worker | — | consome a fila `video-processing` |
| PostgreSQL | `localhost:5432` | db/user/senha: `streamtube` |
| Redis | `localhost:6379` | backend da fila BullMQ |
| MinIO | http://localhost:9000 (API) · http://localhost:9001 (console) | object storage S3 |
| Mailpit | http://localhost:8025 | UI de captura de e-mails |
| Swagger | http://localhost:3000/api/docs | habilite com `SWAGGER_ENABLED=true` |

### Variáveis de ambiente (`.env`)

Lidas pelo Docker Compose **e** pela aplicação (via `@nestjs/config`). Sempre use
o **nome do serviço** do Compose como host, nunca `localhost`.

- **App:** `NODE_ENV`, `PORT`
- **Banco:** `DB_HOST=db`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`
- **Auth:** `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_EXPIRATION`, `JWT_REFRESH_EXPIRATION`, `CONFIRMATION_TOKEN_EXPIRATION_HOURS`, `PASSWORD_RESET_TOKEN_EXPIRATION_HOURS`
- **E-mail:** `MAIL_HOST=mailpit`, `MAIL_PORT`, `MAIL_FROM`
- **Storage (Fase 03):** `STORAGE_ENDPOINT=http://minio:9000`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_FORCE_PATH_STYLE`, `UPLOAD_MAX_BYTES` (padrão `10737418240` = 10 GiB), `UPLOAD_PART_SIZE` (padrão `104857600` = 100 MiB)
- **Fila (Fase 03):** `REDIS_HOST=redis`, `REDIS_PORT`

## Pipeline de Vídeo (Fase 03)

O `VideosModule` cobre todo o ciclo **upload → processamento → entrega**. A tabela
`videos` tem FK para `channels`, um `public_id` único (nanoid, 21 chars) usado nas
URLs públicas e um `status` que dirige o ciclo de vida:
`draft → processing → ready | error`.

**Upload sem bloquear a API (até 10 GB):** o cliente recebe URLs **pré-assinadas**
e envia as partes **direto ao MinIO** (multipart). A API só registra o rascunho,
gera as URLs e, no final, monta as partes — os bytes nunca passam por ela.

**Processamento:** ao concluir o upload, um job `process-video` é publicado na fila
BullMQ `video-processing` (Redis). O `VideoProcessingWorker` (um `WorkerHost`)
baixa o arquivo, roda **ffprobe** (duração/metadados) e **ffmpeg** (thumbnail),
sobe a thumbnail e move o vídeo para `ready` (ou `error` após a última tentativa).
O provider do worker só é registrado quando `VIDEO_WORKER=true`, então a API nunca
executa FFmpeg — isso roda no container `video-worker`.

### Endpoints

**Vídeos** (`videos.controller.ts`):

| Método & Rota | Auth | Status | Descrição |
|---------------|------|--------|-----------|
| `POST /videos` | JWT | 201 | Registra o rascunho e retorna URLs pré-assinadas das partes |
| `POST /videos/:id/complete` | JWT | 202 | Confirma o upload e enfileira o processamento |
| `GET /videos/:publicId` | público | 200 | Metadados públicos (título, status, duração, thumbnail) |
| `GET /videos/:publicId/stream` | público | 302 | Redireciona para URL pré-assinada (streaming inline, Range) |
| `GET /videos/:publicId/download` | público | 302 | Redireciona para URL pré-assinada (`attachment`) |

**Autenticação** (`auth.controller.ts`): `POST /auth/register`,
`GET /auth/confirm-email?token=`, `POST /auth/resend-confirmation`,
`POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/forgot-password`, `POST /auth/reset-password`, `GET /auth/me`.

### Smoke test de upload (pior caso: 10 GB)

Valida o fluxo real ponta a ponta (auth → upload multipart no MinIO →
processamento → entrega) gerando um vídeo válido do tamanho alvo com ffmpeg.
Roda dentro do `video-worker` (tem ffmpeg, node e rede para API/MinIO):

```bash
# Passada rápida (~200 MB)
docker compose exec -e SMOKE_SIZE_BYTES=209715200 video-worker node scripts/smoke-upload.mjs

# Pior caso completo (10 GiB, padrão)
docker compose exec video-worker node scripts/smoke-upload.mjs
```

## Migrations

O `synchronize` do TypeORM é **desabilitado** — o schema evolui por migrations:

```bash
docker compose exec nestjs-api npm run migration:run       # aplica
docker compose exec nestjs-api npm run migration:generate   # gera a partir das entidades
docker compose exec nestjs-api npm run migration:revert      # reverte a última
```

Migrations atuais: `CreateUsersAndChannels`, `CreateAuthTokens`, `CreateVideos`.

## Testes

```bash
docker compose exec nestjs-api npm test                 # unitários + integração
docker compose exec nestjs-api npm run test:e2e         # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov         # cobertura
```

Sufixos: `*.spec.ts` (unitário, tudo mockado), `*.integration-spec.ts` (banco real)
e `*.e2e-spec.ts` (ciclo HTTP completo). Integração/e2e rodam com `--runInBand`.

## Definition of Done

Uma mudança só está pronta quando: suíte relevante + suíte completa **verdes**,
`npx tsc --noEmit` sai com código 0 e `npm run lint` passa.
Detalhes em [`CLAUDE.md`](./CLAUDE.md) (fluxo de dev) e no
[`CLAUDE.md` raiz](../CLAUDE.md) (princípios do projeto).
