import { config } from "./config.js";
import { createPlan } from "./planner.js";
import {
  assembleCourse,
  retryFailedTasks,
  runCourse,
  showStatus
} from "./runner.js";
import { parsePositiveInteger } from "./integer.js";
import { exists } from "./store.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function limit(): number {
  const raw = option("--limit");
  if (!raw) return Number.POSITIVE_INFINITY;

  return parsePositiveInteger(raw, "--limit");
}

function help(): void {
  console.log(`
Usage:
  pnpm plan [-- --force]
  pnpm generate [-- --limit N]
  pnpm resume [-- --limit N]
  pnpm status
  pnpm retry
  pnpm assemble
`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  switch (command) {
    case "plan":
      await createPlan(process.argv.includes("--force"));
      break;

    case "generate":
      if (!(await exists(config.planPath))) {
        await createPlan(false);
      }
      await runCourse(limit());
      break;

    case "run":
      await runCourse(limit());
      break;

    case "status":
      await showStatus();
      break;

    case "retry":
      await retryFailedTasks();
      break;

    case "assemble":
      await assembleCourse();
      console.log("Rebuilt output/course.md.");
      break;

    case "help":
    case "--help":
    case "-h":
      help();
      break;

    default:
      help();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
