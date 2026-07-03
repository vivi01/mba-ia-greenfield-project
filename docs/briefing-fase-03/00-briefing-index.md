# Phase 03 - AI Briefing (index)

This set of files breaks down the original statement
[`StreamTube with AI - MBA Challenge.md`](StreamTube%20with%20AI%20-%20MBA%20Challenge.md)
into focused documents, one per concern, to serve as reference material for the
AI during Phase 03 execution.

> **Golden rule (from the statement):** every piece of information recorded in
> the artifacts must be traceable to the plan or the code. **Do not invent
> requirements, decisions, or behaviors without an identifiable source.**
> These files are a faithful regrouping of the statement — they do not add new
> requirements.

## What Phase 03 is

Implement, end to end, the **Video Upload and Processing** phase of
StreamTube: object storage, processing queue, video worker (FFmpeg), upload of
up to 10GB without blocking the API, automatic processing, thumbnail, unique
URL, streaming, and download. **This is a backend challenge** — the Next.js
frontend exists in the repo but is **out of scope** for this phase.

The delivery is driven by the AI as the process conductor, following the
project's **pipeline planning workflow** and leaving the AI presence observable
in the repository (decisions, planning artifacts, plan, and progress).

## How to use these files

Read them in order. Each stage of the workflow consumes a subset:

| # | File | Purpose | Mainly used in |
|---|------|---------|----------------|
| 01 | [`01-objective-and-scope.md`](01-objective-and-scope.md) | What to deliver and the scope boundaries | All stages |
| 02 | [`02-technical-decisions-to-make.md`](02-technical-decisions-to-make.md) | Open decisions to research and justify | `research` |
| 03 | [`03-workflow-and-artifacts.md`](03-workflow-and-artifacts.md) | Pipeline, skills, artifacts, and phase folder format | All stages |
| 04 | [`04-rules-and-definition-of-done.md`](04-rules-and-definition-of-done.md) | Project rules + Definition of Done | Implementation and closure |
| 05 | [`05-acceptance-criteria.md`](05-acceptance-criteria.md) | Single evaluation checklist | Closure (item-by-item review) |
| 06 | [`06-automatic-failure.md`](06-automatic-failure.md) | Conditions that automatically fail the delivery | Guardrail in all stages |
| 07 | [`07-execution-guide.md`](07-execution-guide.md) | Suggested order + deliverable structure | Starting point / navigation |

## Workflow summary

```
Setup → Research → (context → validate ⇄ resolve → build) → [test-specs] → Implement → Closure
        └ decision ┘  └──────────── planning pipeline ───────────┘        └ DoD + docs ┘
```

The operational starting point is in
[`07-execution-guide.md`](07-execution-guide.md).
