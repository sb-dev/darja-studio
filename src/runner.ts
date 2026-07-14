import { randomUUID } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { config } from "./config.js";
import { validatePlanGraph } from "./graph.js";
import { getOpenAI } from "./openai.js";
import {
  SECTION_CHUNK_INSTRUCTIONS,
  TASK_INSTRUCTIONS,
  sectionChunkInput,
  taskInput
} from "./prompts.js";
import {
  CoursePlanSchema,
  LegacyCompatibleRunStateSchema,
  RunStateSchema,
  TaskResultSchema,
  type CoursePlan,
  type RunState,
  type TaskDefinition
} from "./schemas.js";
import {
  ensureProjectDirectories,
  outputPath,
  readJson,
  readText,
  summaryPath,
  writeJsonAtomic,
  writeText
} from "./store.js";
import { readUsageLedger, summarizeUsage, trackOpenAIResponse } from "./usage.js";

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadProject(): Promise<{
  plan: CoursePlan;
  state: RunState;
}> {
  const [plan, storedState] = await Promise.all([
    readJson(config.planPath, CoursePlanSchema),
    readJson(config.runStatePath, LegacyCompatibleRunStateSchema)
  ]);
  const needsRunId = !storedState.runId;
  const state = RunStateSchema.parse({
    ...storedState,
    runId: storedState.runId ?? randomUUID()
  });

  validatePlanGraph(plan);

  const plannedIds = new Set(plan.tasks.map((task) => task.id));
  for (const task of plan.tasks) {
    if (!state.tasks[task.id]) {
      throw new Error(`Run state is missing task ${task.id}.`);
    }
  }

  for (const taskId of Object.keys(state.tasks)) {
    if (!plannedIds.has(taskId)) {
      throw new Error(`Run state contains unknown task ${taskId}.`);
    }
  }

  if (needsRunId) await saveState(state);
  return { plan, state };
}

async function saveState(state: RunState): Promise<void> {
  state.updatedAt = now();
  await writeJsonAtomic(config.runStatePath, state);
}

async function recoverInterruptedTasks(state: RunState): Promise<void> {
  let changed = false;

  for (const runtime of Object.values(state.tasks)) {
    if (runtime.status === "running") {
      runtime.status = "pending";
      runtime.error = "Previous process stopped while this task was running.";
      changed = true;
    }
  }

  if (changed) await saveState(state);
}

function dependenciesDone(
  task: TaskDefinition,
  state: RunState
): boolean {
  return task.dependsOn.every(
    (dependency) => state.tasks[dependency]?.status === "done"
  );
}

function nextRunnableTask(
  plan: CoursePlan,
  state: RunState
): TaskDefinition | undefined {
  return [...plan.tasks]
    .sort((left, right) => left.order - right.order)
    .find((task) => {
      const runtime = state.tasks[task.id];
      const retryable =
        runtime.status === "pending" ||
        (runtime.status === "failed" &&
          runtime.attempts < config.maxTaskAttempts);

      return retryable && dependenciesDone(task, state);
    });
}

async function dependencyMaterial(
  plan: CoursePlan,
  task: TaskDefinition
): Promise<string> {
  const byId = new Map(plan.tasks.map((candidate) => [candidate.id, candidate]));
  const parts: string[] = [];

  for (const dependencyId of task.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (!dependency) {
      throw new Error(`Unknown dependency ${dependencyId}.`);
    }

    const filePath =
      task.dependencyInput === "summary"
        ? summaryPath(dependencyId)
        : outputPath(dependency.outputFile);

    const value = await readText(filePath);
    parts.push(
      `\n--- DEPENDENCY: ${dependencyId} — ${dependency.title} ---\n\n${value}`
    );
  }

  return parts.join("\n");
}

async function generateTask(
  plan: CoursePlan,
  task: TaskDefinition,
  runId: string,
  attempt: number
): Promise<void> {
  if (task.kind === "section-editor") {
    await generateSectionTask(plan, task, runId, attempt);
    return;
  }

  const dependencies = await dependencyMaterial(plan, task);

  const response = await trackOpenAIResponse(
    runId,
    { operation: "task", taskId: task.id, attempt },
    () => getOpenAI().responses.parse({
    model: config.model,
    instructions: TASK_INSTRUCTIONS,
    input: taskInput(plan, task, dependencies),
    max_output_tokens: config.maxOutputTokens,
    ...(task.webSearch
      ? { tools: [{ type: "web_search" as const }] }
      : {}),
    text: {
      format: zodTextFormat(TaskResultSchema, "course_task_result")
    }
  })
  );

  const result = response.output_parsed;
  if (!result) {
    throw new Error(`Task ${task.id} returned no parsed result.`);
  }

  await Promise.all([
    writeText(outputPath(task.outputFile), `${result.content.trim()}\n`),
    writeText(summaryPath(task.id), `${result.summary.trim()}\n`)
  ]);
}

async function generateSectionTask(
  plan: CoursePlan,
  task: TaskDefinition,
  runId: string,
  attempt: number
): Promise<void> {
  const byId = new Map(plan.tasks.map((candidate) => [candidate.id, candidate]));
  const drafts = task.dependsOn.map((dependencyId) => {
    const dependency = byId.get(dependencyId);
    if (!dependency) throw new Error(`Unknown dependency ${dependencyId}.`);
    if (dependency.kind !== "chapter-draft") {
      throw new Error(
        `Section editor ${task.id} has non-chapter dependency ${dependencyId}.`
      );
    }
    return dependency;
  });

  if (drafts.length === 0) {
    throw new Error(`Section editor ${task.id} has no chapter drafts.`);
  }

  const summaries = await Promise.all(
    drafts.map(async (draft) => ({
      draft,
      content: await readText(summaryPath(draft.id))
    }))
  );
  const sectionContext = summaries
    .map(
      ({ draft, content }) =>
        `## ${draft.title} (${draft.id})\n\n${content.trim()}`
    )
    .join("\n\n");

  const chunks: string[] = [];
  const chunkSummaries: string[] = [];

  for (const [index, draft] of drafts.entries()) {
    const draftContent = await readText(outputPath(draft.outputFile));
    const response = await trackOpenAIResponse(
      runId,
      {
        operation: "section_chunk",
        taskId: task.id,
        attempt,
        draftId: draft.id,
        chunkIndex: index,
        chunkCount: drafts.length
      },
      () => getOpenAI().responses.parse({
      model: config.model,
      instructions: SECTION_CHUNK_INSTRUCTIONS,
      input: sectionChunkInput(
        plan,
        task,
        draft,
        draftContent,
        sectionContext,
        index,
        drafts.length
      ),
      max_output_tokens: config.maxOutputTokens,
      ...(task.webSearch
        ? { tools: [{ type: "web_search" as const }] }
        : {}),
      text: {
        format: zodTextFormat(TaskResultSchema, "course_section_chunk")
      }
    })
    );

    const result = response.output_parsed;
    if (!result) {
      throw new Error(
        `Section editor ${task.id} returned no parsed result for ${draft.id}.`
      );
    }

    chunks.push(result.content.trim());
    chunkSummaries.push(`- ${draft.title}: ${result.summary.trim()}`);
  }

  await Promise.all([
    writeText(outputPath(task.outputFile), `${chunks.join("\n\n").trim()}\n`),
    writeText(summaryPath(task.id), `${chunkSummaries.join("\n")}\n`)
  ]);
}

async function executeTask(
  plan: CoursePlan,
  state: RunState,
  task: TaskDefinition
): Promise<boolean> {
  const runtime = state.tasks[task.id];

  while (runtime.attempts < config.maxTaskAttempts) {
    runtime.attempts += 1;
    runtime.status = "running";
    runtime.startedAt = now();
    runtime.error = undefined;
    await saveState(state);

    console.log(
      `[${task.id}] ${task.title} — attempt ${runtime.attempts}/${config.maxTaskAttempts}`
    );

    try {
      await generateTask(plan, task, state.runId, runtime.attempts);
      runtime.status = "done";
      runtime.completedAt = now();
      runtime.error = undefined;
      await saveState(state);
      console.log(`[${task.id}] done`);
      return true;
    } catch (error) {
      runtime.status = "failed";
      runtime.error = errorMessage(error);
      await saveState(state);
      console.error(`[${task.id}] failed: ${runtime.error}`);

      if (runtime.attempts < config.maxTaskAttempts) {
        await delay(1_000 * 2 ** (runtime.attempts - 1));
      }
    }
  }

  return false;
}

export async function runCourse(limit = Number.POSITIVE_INFINITY): Promise<void> {
  await ensureProjectDirectories();
  const { plan, state } = await loadProject();
  await recoverInterruptedTasks(state);

  let executed = 0;

  while (executed < limit) {
    const task = nextRunnableTask(plan, state);
    if (!task) break;

    await executeTask(plan, state, task);
    executed += 1;
  }

  const runtimes = Object.values(state.tasks);
  const done = runtimes.filter((task) => task.status === "done").length;
  const failed = runtimes.filter(
    (task) =>
      task.status === "failed" &&
      task.attempts >= config.maxTaskAttempts
  );

  console.log(`Progress: ${done}/${plan.tasks.length} tasks complete.`);

  if (done === plan.tasks.length) {
    await assembleCourse();
    console.log("Course complete: output/course.md");
    return;
  }

  if (failed.length > 0) {
    throw new Error(
      `${failed.length} task(s) exhausted their retries. Run ` +
        "`pnpm retry`, then `pnpm resume`."
    );
  }

  const blocked = plan.tasks.filter((task) => {
    const runtime = state.tasks[task.id];
    return runtime.status !== "done" && !dependenciesDone(task, state);
  });

  if (executed < limit && blocked.length > 0) {
    throw new Error(
      `No runnable task remains, but ${blocked.length} task(s) are blocked.`
    );
  }
}

export async function assembleCourse(): Promise<void> {
  const { plan, state } = await loadProject();

  const required = plan.tasks.filter((task) => task.includeInCourse);
  const incomplete = required.filter(
    (task) => state.tasks[task.id]?.status !== "done"
  );
  if (incomplete.length > 0) {
    const ids = incomplete.map((task) => task.id).join(", ");
    throw new Error(
      `Cannot assemble an incomplete course; unfinished final tasks: ${ids}.`
    );
  }

  const selected = [...required].sort((left, right) => left.order - right.order);

  if (selected.length === 0) {
    throw new Error("No completed final artefacts are available to assemble.");
  }

  const parts = [`# ${plan.courseTitle}`];

  for (const task of selected) {
    const content = await readText(outputPath(task.outputFile));
    parts.push(content.trim());
  }

  await writeText(
    outputPath("course.md"),
    `${parts.join("\n\n---\n\n")}\n`
  );

  const manifest = selected
    .map((task) => `- ${task.id}: \`${task.outputFile}\``)
    .join("\n");

  await writeText(
    outputPath("manifest.md"),
    `# Course assembly manifest\n\n${manifest}\n`
  );
}

export async function showStatus(): Promise<void> {
  const { plan, state } = await loadProject();
  const usage = summarizeUsage(await readUsageLedger(), state.runId);
  const counts = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0
  };

  for (const task of plan.tasks) {
    counts[state.tasks[task.id].status] += 1;
  }

  console.log(`Course: ${plan.courseTitle}`);
  console.log(`Model: ${config.model}`);
  console.log(`Pending: ${counts.pending}`);
  console.log(`Running: ${counts.running}`);
  console.log(`Done: ${counts.done}`);
  console.log(`Failed: ${counts.failed}`);
  console.log(`API responses: ${usage.responses}`);
  console.log(`Web searches: ${usage.webSearches}`);
  console.log(
    `Input tokens: ${usage.input} (${usage.cachedInput} cached, ${usage.cacheWrite} cache write)`
  );
  console.log(`Output tokens: ${usage.output} (${usage.reasoning} reasoning)`);
  console.log(`Estimated cost: $${usage.costUsd.toFixed(6)}`);
  if (usage.unknownCostEvents > 0) {
    console.log(`Unknown-cost events: ${usage.unknownCostEvents}`);
  }

  for (const task of plan.tasks) {
    const runtime = state.tasks[task.id];
    if (runtime.status === "failed") {
      console.log(
        `\n${task.id} (${runtime.attempts} attempts)\n  ${runtime.error ?? "Unknown error"}`
      );
    }
  }
}

export async function retryFailedTasks(): Promise<void> {
  const { state } = await loadProject();
  let reset = 0;

  for (const runtime of Object.values(state.tasks)) {
    if (runtime.status === "failed") {
      runtime.status = "pending";
      runtime.attempts = 0;
      runtime.error = undefined;
      runtime.startedAt = undefined;
      runtime.completedAt = undefined;
      reset += 1;
    }
  }

  await saveState(state);
  console.log(`Reset ${reset} failed task(s).`);
}
