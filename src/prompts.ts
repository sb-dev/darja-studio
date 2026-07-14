import type { CoursePlan, TaskDefinition } from "./schemas.js";

export const PLANNER_INSTRUCTIONS = `
You are designing a practical generation plan for a complete Algerian Darja
language course.

Convert the supplied course specification into a dependency-aware task graph.
Do not write the course itself.

Planning rules:

1. Create one foundation task that establishes the teaching method, dialect
   baseline, transliteration rules, chapter template, citation policy and audio
   script conventions.
2. Create one introduction task.
3. Create one chapter-draft task for every chapter in the specification.
4. Create one section-editor task for every section. It must depend only on the
   chapter drafts in that section and produce the complete revised section.
5. Chapter drafts are intermediate: includeInCourse must be false.
6. Section editor outputs are final: includeInCourse must be true.
7. Introduction and final appendix outputs may be included in the course.
8. Use dependencyInput "full" when an editor must read complete chapter drafts.
   Use "summary" for cross-course review or appendix work.
9. Keep the graph under 80 tasks.
10. Make every task independently executable from its instructions, the compact
    course brief and its dependency material.
11. Use webSearch for factual linguistic, regional, cultural, culinary, musical
    or historical work. Editing-only tasks normally do not need web search.
12. Supply focused researchQueries in English, French and Arabic where useful.
13. A chapter task must request:
    - communicative outcome;
    - productive and recognition vocabulary;
    - reusable sentence frames;
    - Arabic script, consistent transliteration and natural English;
    - dialogues;
    - pronunciation;
    - exercises and retrieval;
    - bounded regional notes;
    - cultural or historical material only when relevant;
    - TTS-ready scripts and recording notes;
    - inline citations and a source list when research is used.
14. A section-editor task must return the complete polished section, not merely
    comments about the drafts.
15. outputFile values must be unique relative Markdown paths under output/.
16. order controls final assembly order for tasks with includeInCourse true.
17. Avoid a final task that requires every full section as input. The local
    runner performs deterministic assembly.
18. The course brief should preserve the essential teaching, cultural,
    historical and audio constraints in no more than roughly 1,500 words.
`;

export function plannerInput(specification: string): string {
  return `
Create the course-generation task graph from this specification.

--- COURSE SPECIFICATION ---

${specification}

--- END SPECIFICATION ---
`;
}

export const TASK_INSTRUCTIONS = `
You are producing one artefact in a larger Algerian Darja course.

Follow the task exactly. Treat the supplied course brief and dependency
material as binding context.

Quality rules:

- Teach natural Algerian Darja rather than Modern Standard Arabic relabelled as
  dialect.
- Do not claim that a form is universal when evidence is regional, social or
  generational.
- Distinguish productive vocabulary, recognition vocabulary, French
  code-switching and integrated loanwords.
- Never invent proverbs, etymologies, quotations, song lyrics, historical
  claims or regional forms.
- Do not reproduce copyrighted song lyrics.
- Keep colonial history connected through documented mechanisms such as
  language hierarchy, oral memory, neighbourhood organisation, family
  solidarity, food continuity, music, humour, resistance or migration. Do not
  attach it decoratively to unrelated content.
- Use the web-search tool when it is available. Cite factual claims inline and
  finish researched artefacts with a Sources section containing usable links.
- Mark expressions that still require native-speaker validation.
- Generate TTS-ready scripts and recording direction, not audio.
- Write complete Markdown suitable for saving directly to the task's output
  file.
- The summary must be compact but specific: record what was produced, the
  vocabulary/grammar/cultural scope, regional assumptions, unresolved points
  and what later tasks need to know. Keep it under roughly 700 words.
`;

export const SECTION_CHUNK_INSTRUCTIONS = `
You are editing one chapter-sized chunk of a larger Algerian Darja course
section. The local runner will combine your chunk with the other edited chunks.

Follow the supplied section-editor instructions and course brief, but return
only the requested chapter chunk. Preserve all required teaching material from
the draft while improving consistency, progression, accuracy and readability.
Use the summaries of the other chapters to coordinate terminology, vocabulary
recycling and section-level progression without reproducing their content.

If this is the first chunk, include the section heading and a concise section
introduction before the chapter. If this is the last chunk, include the section
exit task and synthesis after the chapter. Do not add either element to an
intermediate chunk.

Return complete Markdown for this chunk. Keep the summary specific and under
roughly 80 words so all chunk summaries remain compact when combined.
`;

export function taskInput(
  plan: CoursePlan,
  task: TaskDefinition,
  dependencyMaterial: string
): string {
  const queries =
    task.researchQueries.length === 0
      ? "None supplied."
      : task.researchQueries.map((query) => `- ${query}`).join("\n");

  return `
# Course

${plan.courseTitle}

# Compact course brief

${plan.courseBrief}

# Current task

ID: ${task.id}
Title: ${task.title}
Kind: ${task.kind}
Output path: ${task.outputFile}

${task.instructions}

# Suggested research queries

${queries}

# Dependency material

${dependencyMaterial || "This task has no dependency material."}

Return:
- content: the complete Markdown artefact;
- summary: a compact state summary for later tasks.
`;
}

export function sectionChunkInput(
  plan: CoursePlan,
  task: TaskDefinition,
  draft: TaskDefinition,
  draftContent: string,
  sectionContext: string,
  index: number,
  total: number
): string {
  return `
# Course

${plan.courseTitle}

# Compact course brief

${plan.courseBrief}

# Section editing task

Title: ${task.title}

${task.instructions}

# Current chapter chunk

Chunk ${index + 1} of ${total}
Draft ID: ${draft.id}
Draft title: ${draft.title}
First chunk: ${index === 0 ? "yes" : "no"}
Last chunk: ${index === total - 1 ? "yes" : "no"}

--- BEGIN CHAPTER DRAFT ---

${draftContent}

--- END CHAPTER DRAFT ---

# Other chapter summaries for section-level consistency

${sectionContext}

Return:
- content: the complete edited Markdown for only this chunk;
- summary: an under-80-word summary of the edited chunk.
`;
}
