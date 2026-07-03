/**
 * End-to-end upload smoke test for the video pipeline — the "worst case" (10GB).
 *
 * Drives the REAL flow against a running Docker environment, exercising the
 * multipart/presigned upload strategy that keeps large files OFF the API:
 *
 *   register -> confirm (via Mailpit) -> login
 *   -> POST /videos            (init: draft + presigned part URLs)
 *   -> PUT each part directly to MinIO (bytes never touch the API)
 *   -> POST /videos/:id/complete (assemble + enqueue processing)
 *   -> poll GET /videos/:publicId until status = ready | error
 *   -> check /stream and /download deliver 302 redirects
 *
 * A valid MP4 of ~SMOKE_SIZE_BYTES is generated with ffmpeg (a small seed clip
 * looped with stream-copy), so PROCESSING (ffprobe + thumbnail) also succeeds —
 * not just the transfer. Supply SMOKE_VIDEO_PATH to use your own real video.
 *
 * WHERE TO RUN — inside the `video-worker` container, which has ffmpeg, node,
 * and network access to both `nestjs-api:9000`-side services:
 *
 *   docker compose exec video-worker node scripts/smoke-upload.mjs
 *
 * Quick sanity pass before the full 10GB run (≈200 MB, ~1 min):
 *
 *   docker compose exec -e SMOKE_SIZE_BYTES=209715200 video-worker node scripts/smoke-upload.mjs
 *
 * Env knobs (all optional):
 *   SMOKE_SIZE_BYTES  target file size in bytes            (default 10737418240 = 10 GiB)
 *   SMOKE_VIDEO_PATH  use this existing file instead of generating one
 *   API_BASE          API base URL          (default http://nestjs-api:3000)
 *   MAILPIT_BASE      Mailpit base URL      (default http://mailpit:8025)
 *   SMOKE_WORKDIR     scratch dir for the generated file (default /tmp/streamtube-smoke)
 *   SMOKE_KEEP_FILE   "true" to keep the generated file    (default delete it)
 *   PROCESS_TIMEOUT_MS how long to wait for status=ready    (default 1800000 = 30 min)
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_BASE = process.env.API_BASE ?? 'http://nestjs-api:3000';
const MAILPIT_BASE = process.env.MAILPIT_BASE ?? 'http://mailpit:8025';
const TARGET_BYTES = Number(process.env.SMOKE_SIZE_BYTES ?? 10_737_418_240);
const WORKDIR = process.env.SMOKE_WORKDIR ?? '/tmp/streamtube-smoke';
const KEEP_FILE = process.env.SMOKE_KEEP_FILE === 'true';
const PROCESS_TIMEOUT_MS = Number(process.env.PROCESS_TIMEOUT_MS ?? 1_800_000);
const PROVIDED_VIDEO = process.env.SMOKE_VIDEO_PATH;

const CONTENT_TYPE = 'video/mp4';
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (msg) => console.log(`[${elapsed()}s] ${msg}`);
const fmtBytes = (n) =>
  n >= GiB ? `${(n / GiB).toFixed(2)} GiB` : `${(n / MiB).toFixed(1)} MiB`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // The API applies a global per-IP rate limiter (ThrottlerGuard). Every call
  // from this script shares one IP, so tolerate 429 by honouring Retry-After.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    if (res.status !== 429 || attempt >= 6) return res;
    const retryAfter = Number(res.headers.get('retry-after')) || 15;
    log(`  429 rate-limited on ${method} ${path}; waiting ${retryAfter}s…`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
  }
}

async function apiJson(method, path, opts) {
  const res = await api(method, path, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// 1. Auth: register a throwaway account, confirm via Mailpit, log in
// ---------------------------------------------------------------------------
async function authenticate() {
  const email = `smoke+${randomUUID()}@streamtube.local`;
  const password = 'Smoke-Test-1234!';

  log(`Registering throwaway user ${email}`);
  await apiJson('POST', '/auth/register', { body: { email, password } });

  log('Fetching confirmation token from Mailpit…');
  const token = await pollMailpitForToken(email);
  await api('GET', `/auth/confirm-email?token=${encodeURIComponent(token)}`);
  log('Email confirmed.');

  const { access_token } = await apiJson('POST', '/auth/login', {
    body: { email, password },
  });
  log('Logged in — access token acquired.');
  return access_token;
}

async function pollMailpitForToken(email, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${MAILPIT_BASE}/api/v1/messages?limit=50`);
    if (res.ok) {
      const { messages = [] } = await res.json();
      const msg = messages.find((m) =>
        (m.To ?? []).some((r) => r.Address === email),
      );
      if (msg) {
        const detail = await (
          await fetch(`${MAILPIT_BASE}/api/v1/message/${msg.ID}`)
        ).json();
        const html = detail.HTML ?? detail.Text ?? '';
        const match = html.match(/confirm-email\?token=([^"'&\s<]+)/);
        if (match) return match[1];
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No confirmation email for ${email} appeared in Mailpit`);
}

// ---------------------------------------------------------------------------
// 2. Produce a valid MP4 of ~TARGET_BYTES (or use SMOKE_VIDEO_PATH)
// ---------------------------------------------------------------------------
async function ensureVideoFile() {
  if (PROVIDED_VIDEO) {
    const { size } = await stat(PROVIDED_VIDEO);
    log(`Using provided video ${PROVIDED_VIDEO} (${fmtBytes(size)})`);
    return { path: PROVIDED_VIDEO, size, generated: false };
  }

  await mkdir(WORKDIR, { recursive: true });
  const seed = join(WORKDIR, 'seed.mp4');
  const out = join(WORKDIR, 'smoke.mp4');

  log('Generating seed clip with ffmpeg…');
  // 20s of high-motion test video at a high bitrate → a chunky, valid seed.
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=20:size=1280x720:rate=30',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-b:v', '120M', '-maxrate', '120M', '-bufsize', '240M',
    '-pix_fmt', 'yuv420p',
    seed,
  ]);

  const { size: seedSize } = await stat(seed);
  // stream_loop N repeats the input N extra times (total N+1).
  const loops = Math.max(0, Math.ceil(TARGET_BYTES / seedSize) - 1);
  log(
    `Seed is ${fmtBytes(seedSize)}; looping x${loops + 1} (stream-copy) to reach ~${fmtBytes(TARGET_BYTES)}…`,
  );
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-stream_loop', String(loops), '-i', seed,
    '-c', 'copy', out,
  ]);

  const { size } = await stat(out);
  log(`Generated ${out} — actual size ${fmtBytes(size)} (${size} bytes)`);
  return { path: out, size, generated: true };
}

// ---------------------------------------------------------------------------
// 3. Upload each part directly to MinIO via the presigned URLs
// ---------------------------------------------------------------------------
async function uploadParts(filePath, initResult) {
  const { part_size: partSize, parts } = initResult;
  const fh = await open(filePath, 'r');
  const buffer = Buffer.allocUnsafe(partSize);
  const completed = [];
  const uploadStart = Date.now();
  let uploadedBytes = 0;
  try {
    for (const part of parts) {
      const offset = (part.part_number - 1) * partSize;
      const { bytesRead } = await fh.read(buffer, 0, partSize, offset);
      const body = buffer.subarray(0, bytesRead);
      const res = await fetch(part.url, { method: 'PUT', body });
      if (!res.ok) {
        throw new Error(
          `PUT part ${part.part_number} -> ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      const etag = res.headers.get('etag');
      if (!etag) throw new Error(`part ${part.part_number} returned no ETag`);
      completed.push({ part_number: part.part_number, etag });

      uploadedBytes += bytesRead;
      const secs = (Date.now() - uploadStart) / 1000;
      const mbps = secs > 0 ? uploadedBytes / MiB / secs : 0;
      log(
        `  part ${part.part_number}/${parts.length} ok — ${fmtBytes(uploadedBytes)} total, ${mbps.toFixed(1)} MiB/s`,
      );
    }
  } finally {
    await fh.close();
  }
  return completed;
}

// ---------------------------------------------------------------------------
// 4. Poll processing to completion
// ---------------------------------------------------------------------------
async function waitForReady(publicId) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const view = await apiJson('GET', `/videos/${publicId}`);
    if (view.status !== last) {
      log(`  status = ${view.status}`);
      last = view.status;
    }
    if (view.status === 'ready') return view;
    if (view.status === 'error') {
      throw new Error(`Processing ended in status=error for ${publicId}`);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error(`Timed out waiting for ${publicId} to become ready`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`Worst-case upload smoke test — target ${fmtBytes(TARGET_BYTES)}`);
  log(`API=${API_BASE}  Mailpit=${MAILPIT_BASE}`);

  const token = await authenticate();
  const video = await ensureVideoFile();

  log('POST /videos (init upload)…');
  const init = await apiJson('POST', '/videos', {
    token,
    body: {
      filename: 'smoke.mp4',
      content_type: CONTENT_TYPE,
      size_bytes: video.size,
      title: `smoke ${new Date().toISOString()}`,
    },
  });
  log(
    `init ok — video ${init.public_id}, ${init.parts.length} parts of ${fmtBytes(init.part_size)}`,
  );

  log('Uploading parts directly to MinIO (API is not in the byte path)…');
  const parts = await uploadParts(video.path, init);

  log('POST /videos/:id/complete (assemble + enqueue)…');
  const done = await apiJson('POST', `/videos/${init.id}/complete`, {
    token,
    body: { parts },
  });
  log(`complete ok — status now ${done.status}; waiting for processing…`);

  const ready = await waitForReady(init.public_id);
  log(
    `PROCESSED — duration=${ready.duration_seconds}s, thumbnail=${ready.thumbnail_url ? 'present' : 'MISSING'}`,
  );

  // Delivery checks (public, expect 302 redirects to presigned URLs).
  const stream = await api('GET', `/videos/${init.public_id}/stream`);
  const download = await api('GET', `/videos/${init.public_id}/download`);
  log(`GET /stream   -> ${stream.status} (expect 302)`);
  log(`GET /download -> ${download.status} (expect 302)`);

  const ok =
    ready.status === 'ready' &&
    !!ready.thumbnail_url &&
    stream.status === 302 &&
    download.status === 302;

  if (video.generated && !KEEP_FILE) {
    await rm(WORKDIR, { recursive: true, force: true });
    log('Cleaned up generated file.');
  }

  if (!ok) throw new Error('Smoke test FAILED one or more assertions.');
  log('✅ SMOKE TEST PASSED — 10GB worst case works end to end.');
}

main().catch((err) => {
  log(`❌ ${err.message}`);
  process.exitCode = 1;
});
