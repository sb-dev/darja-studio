import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { config } from "../src/config.js";
import { validatePlanGraph } from "../src/graph.js";
import { parsePositiveInteger } from "../src/integer.js";
import { getOpenAI } from "../src/openai.js";
import { sectionChunkInput } from "../src/prompts.js";
import {
  NoParsedResultError,
  UsageLedgerEntrySchema,
  buildFailureLedgerEntry,
  calculateModelCost,
  missingParsedResultError,
  summarizeUsage
} from "../src/usage.js";
import type {
  CoursePlan,
  RunState,
  TaskDefinition
} from "../src/schemas.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/cli.ts");
const tsx = path.join(root, "node_modules/.bin/tsx");

function task(
  id: string,
  overrides: Partial<TaskDefinition> = {}
): TaskDefinition {
  return {
    id,
    order: 0,
    title: id,
    kind: "foundation",
    instructions: "Do the task.",
    dependsOn: [],
    dependencyInput: "summary",
    outputFile: `drafts/${id}.md`,
    includeInCourse: false,
    webSearch: false,
    researchQueries: [],
    ...overrides
  };
}

function plan(tasks: TaskDefinition[]): CoursePlan {
  return {
    courseTitle: "Test course",
    courseBrief: "Test brief",
    tasks
  };
}

async function projectFixture(
  coursePlan: CoursePlan,
  state: RunState | Omit<RunState, "runId">
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "darja-runner-"));
  await mkdir(path.join(directory, "state"), { recursive: true });
  await mkdir(path.join(directory, "output"), { recursive: true });
  await writeFile(
    path.join(directory, "state/plan.json"),
    JSON.stringify(coursePlan)
  );
  await writeFile(
    path.join(directory, "state/run-state.json"),
    JSON.stringify(state)
  );
  return directory;
}

test("OpenAI requests default to a 30-minute timeout", () => {
  assert.equal(config.openAITimeoutMs, 30 * 60 * 1_000);
});

test("the output token cap defaults to a generous runaway backstop", () => {
  assert.equal(config.maxOutputTokens, 64_000);
});

test("reasoning effort resolves to a supported level", () => {
  assert.ok(
    ["minimal", "low", "medium", "high"].includes(config.reasoningEffort),
    `unexpected reasoning effort: ${config.reasoningEffort}`
  );
});

test("max_output_tokens truncation is a non-retryable parse failure", () => {
  const truncated = missingParsedResultError("Task foundation", {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" }
  } as never);
  assert.ok(truncated instanceof NoParsedResultError);
  assert.equal(truncated.retryable, false);

  const other = missingParsedResultError("Task foundation", {
    status: "incomplete",
    incomplete_details: { reason: "content_filter" }
  } as never);
  assert.equal(other.retryable, true);
});

function agentTimeouts(dispatcher: unknown): {
  headersTimeout?: number;
  bodyTimeout?: number;
} {
  const options = Object.getOwnPropertySymbols(dispatcher as object)
    .map((symbol) => (dispatcher as Record<symbol, unknown>)[symbol])
    .find(
      (value): value is { headersTimeout?: number; bodyTimeout?: number } =>
        typeof value === "object" && value !== null && "headersTimeout" in value
    );
  return options ?? {};
}

// The client `timeout` only arms an AbortController; the transport enforces its own
// headersTimeout (300s by default) and silently caps every long task without it.
test("OpenAI transport timeouts match the configured request timeout", () => {
  process.env.OPENAI_API_KEY ??= "test-key";
  const dispatcher = getOpenAI().fetchOptions?.dispatcher;

  assert.ok(dispatcher, "client must pin a dispatcher rather than inherit the default");
  const timeouts = agentTimeouts(dispatcher);
  assert.equal(timeouts.headersTimeout, config.openAITimeoutMs);
  assert.equal(timeouts.bodyTimeout, config.openAITimeoutMs);
});

// Node's bundled fetch rejects a dispatcher built by a mismatched undici version,
// failing instantly with UND_ERR_INVALID_ARG instead of honouring the timeout.
test("the configured fetch honours its dispatcher's headersTimeout", async () => {
  const server = createServer(() => {
    // Accept the request but never send headers, like a long reasoning run.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const started = Date.now();
  try {
    await undiciFetch(`http://127.0.0.1:${port}/`, {
      dispatcher: new Agent({ headersTimeout: 1_000, bodyTimeout: 1_000 })
    });
    assert.fail("request should have timed out");
  } catch (error) {
    assert.equal(
      ((error as { cause?: { code?: string } }).cause ?? {}).code,
      "UND_ERR_HEADERS_TIMEOUT"
    );
    assert.ok(Date.now() - started < 30_000, "must use the dispatcher's timeout");
  } finally {
    server.close();
  }
});

test("positive integer parsing rejects partially numeric values", () => {
  assert.equal(parsePositiveInteger("3", "--limit"), 3);
  for (const invalid of ["3junk", "1.5", "0", "-1", " 3", "3 "]) {
    assert.throws(
      () => parsePositiveInteger(invalid, "--limit"),
      /must be a positive integer/
    );
  }
});

test("section editors require full chapter-draft dependencies", () => {
  const chapter = task("chapter", { kind: "chapter-draft" });
  const validEditor = task("editor", {
    kind: "section-editor",
    dependsOn: ["chapter"],
    dependencyInput: "full",
    includeInCourse: true
  });
  assert.doesNotThrow(() => validatePlanGraph(plan([chapter, validEditor])));

  const invalidEditor = {
    ...validEditor,
    dependsOn: ["foundation"]
  };
  assert.throws(
    () =>
      validatePlanGraph(
        plan([
          task("foundation"),
          invalidEditor
        ])
      ),
    /non-chapter dependency/
  );
});

test("section chunk prompts identify section boundaries", () => {
  const chapter = task("chapter", {
    kind: "chapter-draft",
    title: "Chapter one"
  });
  const editor = task("editor", {
    kind: "section-editor",
    dependsOn: ["chapter"],
    dependencyInput: "full"
  });
  const input = sectionChunkInput(
    plan([chapter, editor]),
    editor,
    chapter,
    "# Draft",
    "Sibling summaries",
    0,
    1
  );
  assert.match(input, /First chunk: yes/);
  assert.match(input, /Last chunk: yes/);
  assert.match(input, /# Draft/);
  assert.match(input, /Sibling summaries/);
});

test("persisted plans are graph-validated by CLI commands", async () => {
  const first = task("first", {
    dependsOn: ["second"],
    includeInCourse: true
  });
  const second = task("second", { dependsOn: ["first"] });
  const state: RunState = {
    runId: "00000000-0000-4000-8000-000000000001",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    tasks: {
      first: { status: "pending", attempts: 0 },
      second: { status: "pending", attempts: 0 }
    }
  };
  const cwd = await projectFixture(plan([first, second]), state);
  const result = spawnSync(tsx, [cli, "status"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependency cycle detected/);
});

test("assembly refuses unfinished final artifacts", async () => {
  const finalTask = task("final", { includeInCourse: true });
  const state: RunState = {
    runId: "00000000-0000-4000-8000-000000000001",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    tasks: {
      final: { status: "pending", attempts: 0 }
    }
  };
  const cwd = await projectFixture(plan([finalTask]), state);
  const result = spawnSync(tsx, [cli, "assemble"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot assemble an incomplete course/);
});


test("GPT-5.6 pricing separates cached and cache-write tokens", () => {
  const calculated = calculateModelCost("gpt-5.6", "gpt-5.6-sol", {
    input_tokens: 1_000,
    input_tokens_details: {
      cached_tokens: 200,
      cache_write_tokens: 100
    },
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 40 },
    total_tokens: 1_100
  });

  assert.equal(calculated.rates?.longContext, false);
  assert.equal(calculated.rates?.cacheWritePerMillion, 6.25);
  assert.equal(calculated.costUsd, 0.007225);
  assert.deepEqual(calculated.tokens, {
    input: 1_000,
    cachedInput: 200,
    cacheWrite: 100,
    output: 100,
    reasoning: 40,
    total: 1_100
  });
});

test("GPT-5.6 long-context pricing begins above 272,000 input tokens", () => {
  const boundary = calculateModelCost("gpt-5.6", null, {
    input_tokens: 272_000,
    output_tokens: 0,
    total_tokens: 272_000
  });
  const long = calculateModelCost("gpt-5.6-sol", null, {
    input_tokens: 272_001,
    output_tokens: 0,
    total_tokens: 272_001
  });

  assert.equal(boundary.rates?.longContext, false);
  assert.equal(boundary.rates?.inputPerMillion, 5);
  assert.equal(long.rates?.longContext, true);
  assert.equal(long.rates?.inputPerMillion, 10);
  assert.equal(long.rates?.cachedInputPerMillion, 1);
  assert.equal(long.rates?.cacheWritePerMillion, 12.5);
  assert.equal(long.rates?.outputPerMillion, 45);
});

test("unknown models track tokens without inventing a cost", () => {
  const calculated = calculateModelCost("custom-model", null, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15
  });

  assert.equal(calculated.tokens.total, 15);
  assert.equal(calculated.rates, null);
  assert.equal(calculated.costUsd, null);
});

test("usage summaries filter by run and include tool-call costs", () => {
  const runId = "00000000-0000-4000-8000-000000000001";
  const otherRunId = "00000000-0000-4000-8000-000000000002";
  const common = {
    schemaVersion: 1 as const,
    timestamp: new Date(0).toISOString(),
    context: { operation: "task" as const, taskId: "chapter", attempt: 1 }
  };
  const entries = [
    UsageLedgerEntrySchema.parse({
      ...common,
      eventId: "00000000-0000-4000-8000-000000000011",
      runId,
      type: "model_response",
      responseId: "resp_1",
      requestedModel: "gpt-5.6",
      returnedModel: "gpt-5.6-sol",
      status: "completed",
      tokens: {
        input: 100,
        cachedInput: 20,
        cacheWrite: 10,
        output: 50,
        reasoning: 5,
        total: 150
      },
      rates: {
        catalogVersion: "test",
        longContext: false,
        inputPerMillion: 5,
        cachedInputPerMillion: 0.5,
        cacheWritePerMillion: 6.25,
        outputPerMillion: 30
      },
      costUsd: 0.002
    }),
    UsageLedgerEntrySchema.parse({
      ...common,
      eventId: "00000000-0000-4000-8000-000000000012",
      runId,
      type: "web_search",
      responseId: "resp_1",
      toolCallId: "search_1",
      action: "search",
      status: "completed",
      catalogVersion: "test",
      costPerCallUsd: 0.01,
      costUsd: 0.01
    }),
    UsageLedgerEntrySchema.parse({
      ...common,
      eventId: "00000000-0000-4000-8000-000000000013",
      runId,
      type: "model_response",
      responseId: null,
      requestedModel: "custom-model",
      returnedModel: null,
      status: "failed",
      tokens: null,
      rates: null,
      costUsd: null,
      error: "failed"
    }),
    UsageLedgerEntrySchema.parse({
      ...common,
      eventId: "00000000-0000-4000-8000-000000000014",
      runId: otherRunId,
      type: "web_search",
      responseId: "resp_2",
      toolCallId: "search_2",
      action: "search",
      status: "completed",
      catalogVersion: "test",
      costPerCallUsd: 0.01,
      costUsd: 0.01
    })
  ];

  assert.deepEqual(summarizeUsage(entries, runId), {
    responses: 2,
    webSearches: 1,
    input: 100,
    cachedInput: 20,
    cacheWrite: 10,
    output: 50,
    reasoning: 5,
    costUsd: 0.012,
    unknownCostEvents: 1
  });
});

test("status backfills legacy run state with a run ID", async () => {
  const finalTask = task("legacy", { includeInCourse: true });
  const legacyState: Omit<RunState, "runId"> = {
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    tasks: {
      legacy: { status: "pending", attempts: 0 }
    }
  };
  const cwd = await projectFixture(plan([finalTask]), legacyState);
  const result = spawnSync(tsx, [cli, "status"], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /API responses: 0/);
  const persisted = JSON.parse(
    await readFile(path.join(cwd, "state/run-state.json"), "utf8")
  ) as { runId?: string };
  assert.match(persisted.runId ?? "", /^[0-9a-f-]{36}$/);
});


test("status reports malformed ledger lines", async () => {
  const finalTask = task("malformed", { includeInCourse: true });
  const state: RunState = {
    runId: "00000000-0000-4000-8000-000000000001",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    tasks: {
      malformed: { status: "pending", attempts: 0 }
    }
  };
  const cwd = await projectFixture(plan([finalTask]), state);
  await writeFile(
    path.join(cwd, "state/usage-ledger.jsonl"),
    "{not valid json}\n"
  );
  const result = spawnSync(tsx, [cli, "status"], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid usage ledger entry on line 1/);
});

test("missing parsed results include response diagnostics", () => {
  const error = missingParsedResultError("Task foundation", {
    id: "resp_1",
    _request_id: "req_1",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "reasoning" }]
  });
  assert.match(error.message, /status=incomplete/);
  assert.match(error.message, /response_id=resp_1/);
  assert.match(error.message, /request_id=req_1/);
  assert.match(error.message, /incomplete_reason=max_output_tokens/);
  assert.match(error.message, /output_types=reasoning/);
});

test("failed requests map API error metadata onto the ledger entry", () => {
  const apiError = Object.assign(new Error("Request timed out."), {
    name: "APIConnectionTimeoutError",
    status: 504,
    code: "timeout",
    requestID: "req_failed_1"
  });
  const entry = buildFailureLedgerEntry(
    "00000000-0000-4000-8000-000000000001",
    { operation: "task", taskId: "foundation", attempt: 1 },
    apiError,
    12_345
  );

  assert.equal(entry.type, "model_response");
  assert.equal(entry.status, "failed");
  assert.equal(entry.error, "Request timed out.");
  assert.equal(entry.durationMs, 12_345);
  assert.equal(entry.parsed, false);
  assert.equal(entry.requestId, "req_failed_1");
  assert.equal(entry.errorType, "APIConnectionTimeoutError");
  assert.equal(entry.httpStatus, 504);
  assert.equal(entry.errorCode, "timeout");
  // Entry validates against the schema so failure rows persist cleanly.
  assert.doesNotThrow(() => UsageLedgerEntrySchema.parse(entry));
});

test("legacy ledger entries remain valid without diagnostic fields", () => {
  assert.doesNotThrow(() =>
    UsageLedgerEntrySchema.parse({
      schemaVersion: 1,
      eventId: "00000000-0000-4000-8000-000000000010",
      timestamp: new Date(0).toISOString(),
      runId: "00000000-0000-4000-8000-000000000001",
      context: { operation: "task", taskId: "foundation", attempt: 1 },
      type: "model_response",
      responseId: null,
      requestedModel: "gpt-5.6",
      returnedModel: null,
      status: "failed",
      tokens: null,
      rates: null,
      costUsd: null,
      error: "Request timed out."
    })
  );
});
