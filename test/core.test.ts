import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validatePlanGraph } from "../src/graph.js";
import { parsePositiveInteger } from "../src/integer.js";
import { sectionChunkInput } from "../src/prompts.js";
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
  state: RunState
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
