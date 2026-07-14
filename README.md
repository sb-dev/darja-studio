# Darja Studio

A small, resumable TypeScript task runner that turns `spec/course.md` into a complete Markdown course.

It uses the OpenAI Responses API for:

1. **Planning** — converts the course specification into a dependency-aware task graph.
2. **Generation** — writes chapter drafts and TTS scripts.
3. **Section editing** — revises each chapter with section-wide context, then combines the edited chunks into final sections.
4. **Assembly** — joins the approved section outputs into `output/course.md`.

The runner is intentionally file-based. There is no database, queue, web application or agent framework.

## Setup

```bash
cp .env.example .env
# Add OPENAI_API_KEY to .env

pnpm install
pnpm generate
```

`pnpm generate` creates the plan if needed, then runs tasks until the course is complete or a task exhausts its retries.

The process runs in the foreground. It is safe to stop it and resume later:

```bash
pnpm resume
```

## Commands

```bash
pnpm plan                    # Create state/plan.json
pnpm plan -- --force         # Replace the current plan and state
pnpm generate                # Plan if necessary, then run all tasks
pnpm generate -- --limit 3   # Run at most three tasks
pnpm resume                  # Continue an existing run
pnpm status                  # Show progress
pnpm retry                   # Reset exhausted failed tasks
pnpm assemble                # Rebuild output/course.md once all final artefacts are complete
pnpm test
pnpm typecheck
```

## Files

```text
spec/course.md          Course requirements and outline
state/plan.json         Generated task graph
state/run-state.json    Task status, attempts, errors and run ID
state/usage-ledger.jsonl Append-only token and estimated-cost events
state/summaries/        Compact summaries used by later tasks
output/drafts/          Chapter drafts
output/sections/        Edited final sections
output/course.md        Assembled course
```

## How the task graph is shaped

The planner is instructed to create:

- one foundation task;
- one introduction task;
- one draft task per chapter;
- one editor task per section;
- appendix tasks where required.

Chapter drafts are intermediate artefacts. To keep outputs bounded, a section editor processes one complete chapter draft per model response while receiving summaries of the other chapters for section-wide consistency. The edited chunks are combined into the final section. Later cross-course tasks receive compact summaries rather than every complete chapter, keeping prompts manageable.

## Research

Tasks that require linguistic, cultural, food, music or historical evidence can use the Responses API web-search tool. Each task stores its research queries in the generated plan and is instructed to include a source list in its Markdown output.

Web research does not replace native review. The generated course should still be reviewed by speakers from the relevant Algerian regions, especially for dialogue naturalness, pragmatics and pronunciation.

## Audio scope

This version generates **TTS-ready scripts and recording manifests**, not audio files. That keeps the text-generation workflow simple and allows a separate audio pipeline to select an appropriate Algerian model or human speaker later.

## Usage and cost tracking

Every logical Responses API request and each hosted web-search call is appended to `state/usage-ledger.jsonl`. Entries include the current run ID, task context, token breakdown, the versioned GPT-5.6 rates used, and estimated USD cost; prompts and generated content are not stored. `pnpm status` reports totals for the current plan run. Costs are estimates and may differ from the authoritative OpenAI invoice. Unknown models retain token counts but have no estimated cost.

The ledger is intentionally preserved by forced re-planning so historical rows remain available.

## Restarting completely

```bash
rm -f state/plan.json state/run-state.json
rm -rf state/summaries output/drafts output/sections output/appendices
pnpm generate
```
