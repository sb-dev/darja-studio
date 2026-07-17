import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";

const CATALOG_VERSION = "2026-07-14";
const WEB_SEARCH_COST_USD = 0.01;

const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
});

const RatesSchema = z.object({
  catalogVersion: z.string(),
  longContext: z.boolean(),
  inputPerMillion: z.number().nonnegative(),
  cachedInputPerMillion: z.number().nonnegative(),
  cacheWritePerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative()
});

const ContextSchema = z.object({
  operation: z.enum(["planner", "task", "section_chunk"]),
  taskId: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  draftId: z.string().optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  chunkCount: z.number().int().positive().optional(),
  webSearch: z.boolean().optional()
});

const CommonSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  timestamp: z.string(),
  runId: z.string().uuid(),
  context: ContextSchema
});

export const ModelResponseLedgerEntrySchema = CommonSchema.extend({
  type: z.literal("model_response"),
  responseId: z.string().nullable(),
  requestedModel: z.string(),
  returnedModel: z.string().nullable(),
  status: z.string(),
  tokens: TokenUsageSchema.nullable(),
  rates: RatesSchema.nullable(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  requestId: z.string().nullable().optional(),
  errorType: z.string().optional(),
  httpStatus: z.number().int().optional(),
  errorCode: z.string().optional(),
  incompleteReason: z.string().optional(),
  parsed: z.boolean().optional()
});

export const WebSearchLedgerEntrySchema = CommonSchema.extend({
  type: z.literal("web_search"),
  responseId: z.string(),
  toolCallId: z.string(),
  action: z.string(),
  status: z.string(),
  catalogVersion: z.string(),
  costPerCallUsd: z.number().nonnegative(),
  costUsd: z.number().nonnegative()
});

export const UsageLedgerEntrySchema = z.discriminatedUnion("type", [
  ModelResponseLedgerEntrySchema,
  WebSearchLedgerEntrySchema
]);

export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntrySchema>;
export type UsageContext = z.infer<typeof ContextSchema>;

interface ResponseUsage {
  input_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens: number;
}

interface TrackableResponse {
  id?: string;
  _request_id?: string | null;
  model?: string;
  status?: string | null;
  usage?: ResponseUsage | null;
  output?: unknown[];
  output_parsed?: unknown;
  incomplete_details?: { reason?: string | null } | null;
  error?: { code?: string; message?: string } | null;
}

interface TrackableError {
  name?: string;
  status?: number;
  code?: string | null;
  type?: string;
  requestID?: string | null;
  cause?: unknown;
}

interface EffectiveRates {
  catalogVersion: string;
  longContext: boolean;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWritePerMillion: number;
  outputPerMillion: number;
}

function contextLabel(context: UsageContext): string {
  return [context.operation, context.taskId, context.draftId]
    .filter(Boolean)
    .join(":");
}

function causeMessage(error: TrackableError): string | undefined {
  return error.cause === undefined ? undefined : errorMessage(error.cause);
}

export function buildFailureLedgerEntry(
  runId: string,
  context: UsageContext,
  error: unknown,
  durationMs: number
): z.infer<typeof ModelResponseLedgerEntrySchema> {
  const apiError = error as TrackableError;
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    runId,
    context,
    type: "model_response",
    responseId: null,
    requestedModel: config.model,
    returnedModel: null,
    status: "failed",
    tokens: null,
    rates: null,
    costUsd: null,
    error: errorMessage(error),
    durationMs,
    requestId: apiError.requestID ?? null,
    errorType: apiError.name,
    httpStatus: apiError.status,
    errorCode: apiError.code ?? undefined,
    parsed: false
  };
}

export interface UsageSummary {
  responses: number;
  webSearches: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  unknownCostEvents: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function missingParsedResultError(
  label: string,
  response: TrackableResponse
): Error {
  const outputTypes = (response.output ?? [])
    .map((item) =>
      item && typeof item === "object" && "type" in item
        ? String((item as { type: unknown }).type)
        : typeof item
    )
    .join("|");
  const details = [
    `status=${response.status ?? "unknown"}`,
    `response_id=${response.id ?? "unknown"}`,
    `request_id=${response._request_id ?? "unknown"}`,
    response.incomplete_details?.reason
      ? `incomplete_reason=${response.incomplete_details.reason}`
      : undefined,
    response.error?.code ? `error_code=${response.error.code}` : undefined,
    response.error?.message ? `error_message=${response.error.message}` : undefined,
    outputTypes ? `output_types=${outputTypes}` : undefined
  ].filter(Boolean);
  return new Error(`${label} returned no parsed result (${details.join(", ")}).`);
}

function isGpt56(model: string | null): boolean {
  return model === "gpt-5.6" || model === "gpt-5.6-sol";
}

function effectiveRates(
  requestedModel: string,
  returnedModel: string | null,
  inputTokens: number
): EffectiveRates | null {
  if (!isGpt56(requestedModel) && !isGpt56(returnedModel)) return null;

  const longContext = inputTokens > 272_000;
  const inputPerMillion = longContext ? 10 : 5;
  return {
    catalogVersion: CATALOG_VERSION,
    longContext,
    inputPerMillion,
    cachedInputPerMillion: longContext ? 1 : 0.5,
    cacheWritePerMillion: inputPerMillion * 1.25,
    outputPerMillion: longContext ? 45 : 30
  };
}

export function calculateModelCost(
  requestedModel: string,
  returnedModel: string | null,
  usage: ResponseUsage
): {
  tokens: z.infer<typeof TokenUsageSchema>;
  rates: EffectiveRates | null;
  costUsd: number | null;
} {
  const cachedInput = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const uncachedInput = Math.max(
    usage.input_tokens - cachedInput - cacheWrite,
    0
  );
  const tokens = {
    input: usage.input_tokens,
    cachedInput,
    cacheWrite,
    output: usage.output_tokens,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
    total: usage.total_tokens
  };
  const rates = effectiveRates(
    requestedModel,
    returnedModel,
    usage.input_tokens
  );
  if (!rates) return { tokens, rates: null, costUsd: null };

  const costUsd =
    (uncachedInput * rates.inputPerMillion +
      cachedInput * rates.cachedInputPerMillion +
      cacheWrite * rates.cacheWritePerMillion +
      usage.output_tokens * rates.outputPerMillion) /
    1_000_000;
  return { tokens, rates, costUsd };
}

function webSearchItems(output: unknown[] | undefined): Array<{
  id: string;
  action: string;
  status: string;
}> {
  if (!output) return [];
  const items: Array<{ id: string; action: string; status: string }> = [];
  for (const value of output) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (item.type !== "web_search_call" || typeof item.id !== "string") {
      continue;
    }
    const action =
      item.action && typeof item.action === "object"
        ? (item.action as Record<string, unknown>).type
        : undefined;
    items.push({
      id: item.id,
      action: typeof action === "string" ? action : "unknown",
      status: typeof item.status === "string" ? item.status : "unknown"
    });
  }
  return items;
}

async function appendEntries(entries: UsageLedgerEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(config.usageLedgerPath), { recursive: true });
  const value = `${entries
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  await fs.appendFile(config.usageLedgerPath, value, "utf8");
}

export async function trackOpenAIResponse<T>(
  runId: string,
  context: UsageContext,
  request: () => Promise<T>
): Promise<T> {
  const label = contextLabel(context);
  const startedAt = Date.now();
  console.log(
    `[openai:${label}] started requested_model=${config.model} ` +
      `timeout_ms=${config.openAITimeoutMs} web_search=${context.webSearch ?? false}`
  );
  const heartbeat = setInterval(() => {
    console.log(
      `[openai:${label}] waiting elapsed_s=${Math.round(
        (Date.now() - startedAt) / 1_000
      )}`
    );
  }, 30_000);
  heartbeat.unref();

  let result: T;
  try {
    result = await request();
  } catch (error) {
    clearInterval(heartbeat);
    const durationMs = Date.now() - startedAt;
    const apiError = error as TrackableError;
    const cause = causeMessage(apiError);
    console.error(
      `[openai:${label}] failed elapsed_ms=${durationMs} ` +
        `error_type=${apiError.name ?? "unknown"} ` +
        `http_status=${apiError.status ?? "unknown"} ` +
        `error_code=${apiError.code ?? "unknown"} ` +
        `api_type=${apiError.type ?? "unknown"} ` +
        `request_id=${apiError.requestID ?? "unknown"} ` +
        `message=${errorMessage(error)}` +
        (cause ? ` cause=${cause}` : "")
    );
    const entry = buildFailureLedgerEntry(runId, context, error, durationMs);
    try {
      await appendEntries([entry]);
    } catch (ledgerError) {
      throw new AggregateError(
        [error, ledgerError],
        `OpenAI request failed and its ledger entry could not be written: ${errorMessage(error)}`
      );
    }
    throw error;
  }

  clearInterval(heartbeat);
  const durationMs = Date.now() - startedAt;
  const response = result as TrackableResponse;
  const timestamp = new Date().toISOString();
  const returnedModel = response.model ?? null;
  const calculated = response.usage
    ? calculateModelCost(config.model, returnedModel, response.usage)
    : { tokens: null, rates: null, costUsd: null };
  const parsed = response.output_parsed !== undefined && response.output_parsed !== null;
  const entries: UsageLedgerEntry[] = [
    {
      schemaVersion: 1,
      eventId: randomUUID(),
      timestamp,
      runId,
      context,
      type: "model_response",
      responseId: response.id ?? null,
      requestedModel: config.model,
      returnedModel,
      status: response.status ?? "completed",
      tokens: calculated.tokens,
      rates: calculated.rates,
      costUsd: calculated.costUsd,
      durationMs,
      requestId: response._request_id ?? null,
      error: response.error?.message,
      errorCode: response.error?.code,
      incompleteReason: response.incomplete_details?.reason ?? undefined,
      parsed
    }
  ];

  if (response.id) {
    for (const search of webSearchItems(response.output)) {
      entries.push({
        schemaVersion: 1,
        eventId: randomUUID(),
        timestamp,
        runId,
        context,
        type: "web_search",
        responseId: response.id,
        toolCallId: search.id,
        action: search.action,
        status: search.status,
        catalogVersion: CATALOG_VERSION,
        costPerCallUsd: WEB_SEARCH_COST_USD,
        costUsd: WEB_SEARCH_COST_USD
      });
    }
  }

  await appendEntries(entries);
  const succeeded = parsed && (response.status ?? "completed") === "completed";
  const verb = succeeded ? "completed" : "incomplete";
  console.log(
    `[openai:${label}] ${verb} elapsed_ms=${durationMs} ` +
      `status=${response.status ?? "completed"} ` +
      `requested_model=${config.model} ` +
      `returned_model=${returnedModel ?? "unknown"} ` +
      `response_id=${response.id ?? "unknown"} ` +
      `request_id=${response._request_id ?? "unknown"} ` +
      `input_tokens=${calculated.tokens?.input ?? "unknown"} ` +
      `output_tokens=${calculated.tokens?.output ?? "unknown"} parsed=${parsed}`
  );
  return result;
}

export async function readUsageLedger(): Promise<UsageLedgerEntry[]> {
  let value: string;
  try {
    value = await fs.readFile(config.usageLedgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: UsageLedgerEntry[] = [];
  for (const [index, line] of value.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(UsageLedgerEntrySchema.parse(JSON.parse(line)));
    } catch (error) {
      throw new Error(
        `Invalid usage ledger entry on line ${index + 1}: ${errorMessage(error)}`
      );
    }
  }
  return entries;
}

export function summarizeUsage(
  entries: UsageLedgerEntry[],
  runId: string
): UsageSummary {
  const summary: UsageSummary = {
    responses: 0,
    webSearches: 0,
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    unknownCostEvents: 0
  };
  for (const entry of entries) {
    if (entry.runId !== runId) continue;
    if (entry.type === "web_search") {
      summary.webSearches += 1;
      summary.costUsd += entry.costUsd;
      continue;
    }
    summary.responses += 1;
    if (entry.tokens) {
      summary.input += entry.tokens.input;
      summary.cachedInput += entry.tokens.cachedInput;
      summary.cacheWrite += entry.tokens.cacheWrite;
      summary.output += entry.tokens.output;
      summary.reasoning += entry.tokens.reasoning;
    }
    if (entry.costUsd === null) summary.unknownCostEvents += 1;
    else summary.costUsd += entry.costUsd;
  }
  return summary;
}
