import type { CoursePlan } from "./schemas.js";

export function validatePlanGraph(plan: CoursePlan): void {
  if (plan.tasks.length === 0) {
    throw new Error("The generated plan has no tasks.");
  }

  if (plan.tasks.length > 80) {
    throw new Error(`The plan has ${plan.tasks.length} tasks; maximum is 80.`);
  }

  const ids = new Set<string>();
  const outputFiles = new Set<string>();

  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    ids.add(task.id);

    if (outputFiles.has(task.outputFile)) {
      throw new Error(`Duplicate output file: ${task.outputFile}`);
    }
    outputFiles.add(task.outputFile);
  }

  const byIdForValidation = new Map(
    plan.tasks.map((task) => [task.id, task])
  );

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(
          `Task ${task.id} depends on unknown task ${dependency}.`
        );
      }
      if (dependency === task.id) {
        throw new Error(`Task ${task.id} depends on itself.`);
      }
    }

    if (new Set(task.dependsOn).size !== task.dependsOn.length) {
      throw new Error(`Task ${task.id} contains duplicate dependencies.`);
    }

    if (task.kind === "section-editor") {
      if (task.dependsOn.length === 0) {
        throw new Error(`Section editor ${task.id} has no chapter drafts.`);
      }
      if (task.dependencyInput !== "full") {
        throw new Error(`Section editor ${task.id} must use full dependencies.`);
      }
      for (const dependencyId of task.dependsOn) {
        if (byIdForValidation.get(dependencyId)?.kind !== "chapter-draft") {
          throw new Error(
            `Section editor ${task.id} has non-chapter dependency ${dependencyId}.`
          );
        }
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));

  function visit(id: string): void {
    if (visiting.has(id)) {
      throw new Error(`Dependency cycle detected at ${id}.`);
    }
    if (visited.has(id)) return;

    visiting.add(id);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown task ${id}.`);

    for (const dependency of task.dependsOn) {
      visit(dependency);
    }

    visiting.delete(id);
    visited.add(id);
  }

  for (const task of plan.tasks) {
    visit(task.id);
  }

  if (!plan.tasks.some((task) => task.includeInCourse)) {
    throw new Error("No task is marked for final course assembly.");
  }
}
