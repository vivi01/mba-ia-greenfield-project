---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload-init.e2e-spec.ts
---

# Endpoint POST /videos — Upload Initiation Test Plan

## Application Overview

`POST /videos` inicia um upload: pré-cadastra o vídeo como rascunho (`status: 'draft'`) sob o canal do usuário autenticado, abre um upload multipart no object storage e devolve URLs presignadas de parte para o cliente enviar os bytes diretamente ao storage. Requer autenticação; valida `content_type` contra uma allowlist de vídeo e `size_bytes` contra o limite de 10GB.

## Test Scenarios

### 1. Upload initiation

**Setup:** `beforeEach` trunca as tabelas de teste e faz bootstrap do módulo Nest via `Test.createTestingModule(...).compile()` + `supertest`. Semeia um usuário confirmado com seu canal e obtém um `access_token` válido (via fluxo de login). O object storage de teste (MinIO) está disponível para o init multipart.

#### 1.1. init-upload-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ filename: 'clip.mp4', content_type: 'video/mp4', size_bytes: 52428800 }`
    - expect: HTTP 201
    - expect: response body contém `id`, `public_id`, `status: 'draft'`, `upload_id`, `storage_key`, `part_size` e um array `parts` não-vazio com `{ part_number, url }`
    - expect: existe uma linha em `videos` com esse `id`, `status = 'draft'`, `channel_id` do canal do chamador e `upload_id` preenchido

#### 1.2. reject-oversize-file

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos autenticado com body `{ filename: 'huge.mp4', content_type: 'video/mp4', size_bytes: 10737418241 }` (1 byte acima de 10GB)
    - expect: HTTP 413
    - expect: response body `{ statusCode: 413, error: 'FILE_TOO_LARGE', message: <string> }`
    - expect: nenhuma linha nova é criada em `videos`

#### 1.3. reject-unsupported-format

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos autenticado com body `{ filename: 'doc.pdf', content_type: 'application/pdf', size_bytes: 1024 }`
    - expect: HTTP 415
    - expect: response body `{ statusCode: 415, error: 'UNSUPPORTED_VIDEO_FORMAT', message: <string> }`
    - expect: nenhuma linha nova é criada em `videos`

#### 1.4. reject-unauthenticated

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos SEM header `Authorization` e body válido
    - expect: HTTP 401
    - expect: nenhuma linha nova é criada em `videos`

#### 1.5. reject-invalid-body

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos autenticado com body incompleto `{ content_type: 'video/mp4' }` (faltando `filename` e `size_bytes`)
    - expect: HTTP 400
    - expect: response body `{ statusCode: 400, error: 'VALIDATION_ERROR', message: <array de erros de campo> }`
