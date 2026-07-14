import { z } from "zod";

const SafeMarkdownPath = z
  .string()
  .regex(/^[a-zA-Z0-9/_-]+\.md$/, "Must be a relative Markdown path.")
  .refine((value) => !value.includes(".."), "Path traversal is not allowed.");

export const TaskDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  order: z.number().int().nonnegative(),
  title: z.string(),
  kind: z.enum([
    "foundation",
    "introduction",
    "chapter-draft",
    "section-editor",
    "appendix",
    "review"
  ]),
  instructions: z.string(),
  dependsOn: z.array(z.string()),
  dependencyInput: z.enum(["full", "summary"]),
  outputFile: SafeMarkdownPath,
  includeInCourse: z.boolean(),
  webSearch: z.boolean(),
  researchQueries: z.array(z.string())
});

export const CoursePlanSchema = z.object({
  courseTitle: z.string(),
  courseBrief: z.string(),
  tasks: z.array(TaskDefinitionSchema)
});

export const TaskResultSchema = z.object({
  content: z.string(),
  summary: z.string()
});

export const TaskRuntimeSchema = z.object({
  status: z.enum(["pending", "running", "done", "failed"]),
  attempts: z.number().int().nonnegative(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
});

export const RunStateSchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
  tasks: z.record(z.string(), TaskRuntimeSchema)
});

export type CoursePlan = z.infer<typeof CoursePlanSchema>;
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
