---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-complete.e2e-spec.ts
---

# Endpoint POST /videos/:id/complete — Upload Completion Test Plan

## Application Overview

`POST /videos/:id/complete` finaliza o upload multipart no object storage e enfileira o job `process-video`, transicionando o vídeo de `draft` para `processing`. É o gatilho determinístico e backend-owned do processamento. Só o dono do rascunho pode concluir; o vídeo precisa estar aguardando conclusão.

## Test Scenarios

### 1. Upload completion

**Setup:** `beforeEach` trunca as tabelas de teste e faz bootstrap do módulo Nest via `Test.createTestingModule(...).compile()` + `supertest`. Semeia um usuário confirmado (owner) com seu canal e um `access_token`, além de um rascunho de vídeo (`status: 'draft'`, `upload_id` preenchido) pertencente a esse canal. A fila `video-processing` é instrumentada para permitir assertir o enfileiramento.

#### 1.1. complete-upload-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos/:id/complete (id do rascunho do owner) com `Authorization: Bearer <access_token>` e body `{ parts: [{ part_number: 1, etag: '"abc123"' }] }`
    - expect: HTTP 202
    - expect: response body `{ id, public_id, status: 'processing' }`
    - expect: a linha do vídeo passa a `status = 'processing'` com `upload_id` limpo
    - expect: exatamente um job `process-video` é enfileirado na fila `video-processing` com payload `{ videoId, storageKey }`

#### 1.2. reject-unknown-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos/:id/complete autenticado com um `id` (uuid) que não existe
    - expect: HTTP 404
    - expect: response body `{ statusCode: 404, error: 'VIDEO_NOT_FOUND', message: <string> }`
    - expect: nenhum job é enfileirado

#### 1.3. reject-non-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. Semeia um segundo usuário/canal e obtém seu `access_token`
  2. POST /videos/:id/complete com o token do segundo usuário sobre o rascunho do primeiro
    - expect: HTTP 403
    - expect: response body `{ statusCode: 403, error: 'VIDEO_NOT_OWNED', message: <string> }`
    - expect: o vídeo permanece `status = 'draft'`; nenhum job é enfileirado

#### 1.4. reject-invalid-state

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. Ajusta o vídeo semeado para um estado que não aguarda conclusão (ex: `status = 'processing'`)
  2. POST /videos/:id/complete do owner com `parts` válidas
    - expect: HTTP 409
    - expect: response body `{ statusCode: 409, error: 'INVALID_UPLOAD_STATE', message: <string> }`
    - expect: nenhum job adicional é enfileirado

#### 1.5. reject-invalid-parts

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. POST /videos/:id/complete do owner com body `{ parts: [] }` (array vazio) OU `parts` ausente
    - expect: HTTP 400
    - expect: response body `{ statusCode: 400, error: 'VALIDATION_ERROR', message: <array de erros de campo> }`
    - expect: o vídeo permanece `status = 'draft'`; nenhum job é enfileirado
