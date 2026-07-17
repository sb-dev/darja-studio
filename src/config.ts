import "dotenv/config";
import path from "node:path";
import { parsePositiveInteger } from "./integer.js";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  return parsePositiveInteger(raw, name);
}

const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function reasoningEffort(name: string, fallback: ReasoningEffort): ReasoningEffort {
  const raw = process.env[name];
  if (!raw) return fallback;
  if ((REASONING_EFFORTS as readonly string[]).includes(raw)) {
    return raw as ReasoningEffort;
  }
  throw new Error(
    `${name} must be one of ${REASONING_EFFORTS.join(", ")} (received "${raw}").`
  );
}

export const config = {
  rootDir: process.cwd(),
  specPath: path.resolve(process.env.COURSE_SPEC ?? "spec/course.md"),
  planPath: path.resolve("state/plan.json"),
  runStatePath: path.resolve("state/run-state.json"),
  usageLedgerPath: path.resolve("state/usage-ledger.jsonl"),
  summaryDir: path.resolve("state/summaries"),
  outputDir: path.resolve("output"),
  model: process.env.OPENAI_MODEL ?? "gpt-5.6",
  openAITimeoutMs: positiveInteger("OPENAI_TIMEOUT_MS", 30 * 60 * 1_000),
  // A backstop against runaway generation, not a size target — set well above any
  // legitimate task output. A truncation here means a task is over-scoped, not that
  // the value is too low. See `.env.example`.
  maxOutputTokens: positiveInteger("MAX_OUTPUT_TOKENS", 64_000),
  reasoningEffort: reasoningEffort("REASONING_EFFORT", "medium"),
  maxTaskAttempts: positiveInteger("MAX_TASK_ATTEMPTS", 3)
} as const;
