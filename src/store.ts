import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { config } from "./config.js";

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureProjectDirectories(): Promise<void> {
  await Promise.all([
    fs.mkdir(path.dirname(config.planPath), { recursive: true }),
    fs.mkdir(config.summaryDir, { recursive: true }),
    fs.mkdir(config.outputDir, { recursive: true })
  ]);
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

export async function readJson<T>(
  filePath: string,
  schema: z.ZodType<T>
): Promise<T> {
  const value: unknown = JSON.parse(await readText(filePath));
  return schema.parse(value);
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
  await fs.rename(temporaryPath, filePath);
}

export function outputPath(relativePath: string): string {
  const resolved = path.resolve(config.outputDir, relativePath);
  const prefix = `${config.outputDir}${path.sep}`;

  if (!resolved.startsWith(prefix)) {
    throw new Error(`Unsafe output path: ${relativePath}`);
  }

  return resolved;
}

export function summaryPath(taskId: string): string {
  return path.resolve(config.summaryDir, `${taskId}.md`);
}
