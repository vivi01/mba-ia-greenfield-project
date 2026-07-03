# 02 - Technical Decisions to Make (research)

> Source: the statement sections "Phase 03 Scope" and "Requirements > 1.
> Technical decisions (research)".
> Output artifact: `docs/decisions/technical-decisions-phase-03-videos.md`,
> in the format used by the existing decision docs in `docs/decisions/`
> (options, trade-offs, and recommendation **per decision**).

These decisions are the **heart of the research stage**. For each one: research
the options, record the trade-offs, and justify the choice. This document feeds
the planning stage.

## What is already given (not an open decision)

- **Object storage = S3-compatible.** In practice, **MinIO** runs locally in
  Docker (same API as S3) and would be replaced by S3 in production. What you
  decide here is **how to use it** (bucket/key organization, pre-signed upload),
  **not which** storage to use.
- The video worker uses **FFmpeg/ffprobe** to extract metadata and generate the
  thumbnail (the tool is given; the *how* is yours).

## Decision 1 - Queue technology  ⭐ main stack decision

The `docs/project-plan.md` leaves the queue explicitly open ("TBD"). It is the
**main stack decision** for the phase and the only genuinely open one.

- Research options (e.g. Redis-based queues, dedicated brokers, etc.).
- Record trade-offs: operational overhead, NestJS integration, durability,
  retries/dead-letter, and cost of adding it to Compose.
- Choose and justify. Lock the library via context7 (see
  [`04-rules-and-definition-of-done.md`](04-rules-and-definition-of-done.md)).

## Decision 2 - Upload strategy for 10GB without blocking

How to send up to 10GB **without holding the API during the upload**.

- Example: direct upload to storage via **pre-signed URL / multipart**, instead
  of sending the file through the API.
- Define the handshake: draft pre-registration -> credential / URL issuance ->
  confirmation of upload completion -> processing enqueue.

> ⚠️ Passing the 10GB file through the API in a way that blocks the system is
> **automatic failure** (see
> [`06-automatic-failure.md`](06-automatic-failure.md)).

## Decision 3 - Worker and processing

- How the **worker runs** (separate process/container).
- How it **extracts metadata** and **generates the thumbnail**
  (FFmpeg/ffprobe).
- How it consumes the queue and updates DB + storage.

## Decision 4 - Unique URL

- Strategy to generate a **short and unique URL per video**, with no conflict
  with any other video.

## Decision 5 - Streaming

- Streaming strategy that does not require a full download.
- Example: requests with **range / `206 Partial Content`**.

## Decision 6 - Status lifecycle and failures

- The video **status lifecycle** (e.g. draft -> processing -> ready/error).
- What happens **if processing fails**.

## Research output checklist

The decision document must close with these decisions **resolved and
justified** (this is an acceptance criterion):

- [ ] Queue
- [ ] Upload strategy
- [ ] Streaming
- [ ] Processing / thumbnail
- [ ] Status lifecycle

The new libraries confirmed via context7 are fixed later, in `library-refs.md`
during `plan-resolve` (see
[`03-workflow-and-artifacts.md`](03-workflow-and-artifacts.md)).
