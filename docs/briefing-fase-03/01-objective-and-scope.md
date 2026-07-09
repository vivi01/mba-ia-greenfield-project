# 01 - Phase 03 Objective and Scope

> Source: the statement sections "Objective", "Context", and "Phase 03
> Scope".
> Full phase definition in [`docs/project-plan.md`](../project-plan.md)
> (Phase 03).

## Delivery objective

Deliver, in a public fork of `mba-ia-greenfield-project`, continuing the
project:

- **Technical decisions** for the phase (queue, upload strategy, streaming,
  processing, etc.) in `docs/decisions/`.
- **Planning artifacts** in `docs/phases/phase-03-videos/` (`context.md`,
  `validation.md`, the `phase-03-videos.md` plan, `progress.md`, and
  `library-refs.md`).
- **Video module** in the backend, with the new infrastructure (storage,
  queue, and worker) starting through Docker.
- The **functional Phase 03**: upload up to 10GB, automatic processing,
  thumbnail, unique URL, streaming, and download.
- `CLAUDE.md` updated with the video section.

## Capabilities to deliver (functional scope)

1. **Object storage** for video files and thumbnails.
2. **Background processing queue** + a **worker** that consumes it.
3. **Video upload up to 10GB without blocking the system** (do not hold the
   API during the upload).
4. **Automatic draft registration** when upload starts.
5. **Automatic processing after upload**: duration and metadata extraction.
6. **Automatic thumbnail generation** from a video frame.
7. **Unique URL per video**, with no conflicts.
8. **Playback via streaming** (without requiring a full download).
9. **Video download** by the user.

**Original plan deliverables:** working upload up to 10GB, automatic video
processing, streaming, and generated unique URLs.

## Persistence (video entity/table)

A **video** entity/table linked to the channel, containing at minimum:

- Identification (id).
- Owner -> **channel** (relation with the channel, which is 1:1 with the
  user).
- Title.
- **Status** (e.g. draft -> processing -> ready/error).
- Storage keys for the **file** and the **thumbnail**.
- Duration and metadata.
- **Unique URL** identifier.

> The exact model (columns, types, indexes) is defined in the **plan** (Data
> Model), not in this briefing.

## What already exists (do not build again)

- Backend **NestJS 11 + TypeORM + PostgreSQL 17** in `nestjs-project/`, with
  Phases 01 and 02 closed: modules `auth/`, `users/`, `channels/`, `mail/`,
  `common/`, `config/`, `database/`, `swagger/`.
- Each user has a **channel** (1:1), created during signup. Videos belong to a
  channel.
- Global JWT guard, domain exception filter, global `ValidationPipe`, rate
  limiting, versioned migrations, and seeds.
- Current infrastructure in `nestjs-project/compose.yaml`: **only** API,
  PostgreSQL, and Mailpit.
- Next.js frontend in `next-frontend/` (Phases 01-02) — **out of scope**.

## What does not exist (you will build it)

- The **video module** and the **video table**.
- The **object storage service**.
- The **processing queue**.
- The **video worker (FFmpeg)**.

The target architecture (in
[`docs/diagrams/software-arch.mermaid`](../diagrams/software-arch.mermaid)
and in `CLAUDE.md`) already includes these three components as part of Phase
03.

## Scope limits (do not do)

- **Do not** implement the video interface in the frontend — this is backend
  work.
- **Do not** mix scopes (video/channel editing, visibility, player, etc. are
  Phases 04-05).
- **Do not** include cosmetic changes together with functional changes.
- If something outside the scope appears, **record it as a separate task** and
  do not act on it.

The open decisions that feed the planning are in
[`02-technical-decisions-to-make.md`](02-technical-decisions-to-make.md).
