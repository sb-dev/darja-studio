import { randomUUID } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { config } from "./config.js";
import { validatePlanGraph } from "./graph.js";
import { getOpenAI } from "./openai.js";
import { PLANNER_INSTRUCTIONS, plannerInput } from "./prompts.js";
import {
  CoursePlanSchema,
  type RunState
} from "./schemas.js";
import {
  ensureProjectDirectories,
  exists,
  readText,
  writeJsonAtomic
} from "./store.js";
import { missingParsedResultError, trackOpenAIResponse } from "./usage.js";

export async function createPlan(force = false): Promise<void> {
  await ensureProjectDirectories();

  if (!force && (await exists(config.planPath))) {
    throw new Error(
      "A plan already exists. Use `pnpm plan -- --force` to replace it."
    );
  }

  const specification = await readText(config.specPath);
  const runId = randomUUID();

  const response = await trackOpenAIResponse(
    runId,
    { operation: "planner" },
    () =>
      getOpenAI().responses.parse({
        model: config.model,
        instructions: PLANNER_INSTRUCTIONS,
        input: plannerInput(specification),
        max_output_tokens: config.maxOutputTokens,
        reasoning: { effort: config.reasoningEffort },
        text: {
          format: zodTextFormat(CoursePlanSchema, "course_generation_plan")
        }
      })
  );

  const plan = response.output_parsed;
  if (!plan) {
    throw missingParsedResultError("The planner", response);
  }

  validatePlanGraph(plan);

  const now = new Date().toISOString();
  const runState: RunState = {
    runId,
    createdAt: now,
    updatedAt: now,
    tasks: Object.fromEntries(
      plan.tasks.map((task) => [
        task.id,
        {
          status: "pending" as const,
          attempts: 0
        }
      ])
    )
  };

  await writeJsonAtomic(config.planPath, plan);
  await writeJsonAtomic(config.runStatePath, runState);

  console.log(`Created ${plan.tasks.length} tasks in state/plan.json.`);
}
