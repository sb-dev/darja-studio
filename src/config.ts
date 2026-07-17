import "dotenv/config";
import path from "node:path";
import { parsePositiveInteger } from "./integer.js";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  return parsePositiveInteger(raw, name);
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
  maxOutputTokens: positiveInteger("MAX_OUTPUT_TOKENS", 18_000),
  maxTaskAttempts: positiveInteger("MAX_TASK_ATTEMPTS", 3),
} as const;
