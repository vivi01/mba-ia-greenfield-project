---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-delivery.e2e-spec.ts
---

# Endpoints GET /videos/:publicId (+ /stream, /download) — Delivery Test Plan

## Application Overview

As rotas de entrega são públicas e keyadas pelo `public_id`. `GET /videos/:publicId` devolve metadados/status; `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` emitem uma URL GET presignada de curta duração e redirecionam (302), mantendo a API fora do caminho dos bytes — o storage serve `Range`/`206`. Apenas vídeos `ready` são entregues.

## Test Scenarios

### 1. Video delivery

**Setup:** `beforeEach` trunca as tabelas de teste e faz bootstrap do módulo Nest via `Test.createTestingModule(...).compile()` + `supertest`. Semeia um vídeo `ready` (com `public_id`, `storage_key`, `thumbnail_key`, `duration_seconds`) e um vídeo não-`ready` (ex: `status: 'processing'`). As requisições são feitas SEM autenticação (cliente anônimo). O supertest não deve seguir redirects automaticamente (assertir 302 + `Location`).

#### 1.1. get-metadata-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. GET /videos/:publicId (do vídeo `ready`), sem `Authorization`
    - expect: HTTP 200
    - expect: response body `{ public_id, title, status: 'ready', duration_seconds, thumbnail_url, created_at }`
    - expect: `thumbnail_url` é uma string de URL presignada (não-null para o vídeo processado)

#### 1.2. reject-unknown-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. GET /videos/:publicId com um `public_id` inexistente
    - expect: HTTP 404
    - expect: response body `{ statusCode: 404, error: 'VIDEO_NOT_FOUND', message: <string> }`

#### 1.3. stream-ready-redirect

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. GET /videos/:publicId/stream (do vídeo `ready`), sem seguir redirect
    - expect: HTTP 302
    - expect: header `Location` presente, apontando para uma URL GET presignada do objeto original

#### 1.4. download-ready-redirect

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. GET /videos/:publicId/download (do vídeo `ready`), sem seguir redirect
    - expect: HTTP 302
    - expect: header `Location` presente, apontando para uma URL presignada com `Content-Disposition: attachment` (parâmetro `response-content-disposition`)

#### 1.5. reject-not-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-02T14:42:30Z

**Steps:**
  1. GET /videos/:publicId/stream (do vídeo não-`ready`)
    - expect: HTTP 409
    - expect: response body `{ statusCode: 409, error: 'VIDEO_NOT_READY', message: <string> }`
  2. GET /videos/:publicId/download (do mesmo vídeo não-`ready`)
    - expect: HTTP 409
    - expect: response body `{ statusCode: 409, error: 'VIDEO_NOT_READY', message: <string> }`
