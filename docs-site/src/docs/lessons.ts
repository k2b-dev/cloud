import { withoutFencedCode } from "../../scripts/markdown";

export const lessonsSlug = "/contributing/lessons-learned";
export const lessonPrefix = "/contributing/lessons/";

export type LessonFragment = { path: string; body: string };

/** Dated entries first, undated migrated entries last; ties use the filename. */
export const orderLessons = (fragments: LessonFragment[]): LessonFragment[] =>
  fragments.toSorted((a, b) => {
    const aLegacy = a.path.startsWith("legacy/");
    const bLegacy = b.path.startsWith("legacy/");
    if (aLegacy !== bLegacy) return aLegacy ? 1 : -1;
    if (!aLegacy) {
      const dates = b.path.slice(0, 10).localeCompare(a.path.slice(0, 10));
      if (dates) return dates;
    }
    return a.path.localeCompare(b.path);
  });

/** Shared by Fibel and the documentation validator: never write generated Markdown to Git. */
export function renderLessons(template: string, fragments: LessonFragment[]): string {
  // Catch old PRs that still append a row or incident to the shared source page.
  const prose = withoutFencedCode(template);
  if (/^\||^- \*\*(?:What happened|Root cause|Error class|Guard):/m.test(prose)) {
    throw new Error("Move inline lessons into contributing/lessons/YYYY-MM-DD-<unique-slug>.md; keep lessons-learned.md from main.");
  }

  const classes: string[] = [];
  const lessons: LessonFragment[] = [];
  for (const fragment of fragments) {
    if (fragment.body.startsWith("---\n") || fragment.body.startsWith("---\r\n")) {
      throw new Error(`${fragment.path}: lesson fragments must not have frontmatter; put the date in the filename`);
    }
    if (fragment.path.startsWith("classes/")) {
      if (!/^\| .+ \| .+ \| .+ \|$/.test(fragment.body.trim())) {
        throw new Error(`${fragment.path}: historical error class must contain one table row`);
      }
      classes.push(fragment.body.trim());
      continue;
    }
    const fragmentProse = withoutFencedCode(fragment.body);
    if (!/^### .+\r?\n/.test(fragment.body) || (fragmentProse.match(/^#{1,6} /gm)?.length ?? 0) !== 1) {
      throw new Error(`${fragment.path}: lesson must contain one level-three heading`);
    }
    if (!fragment.path.startsWith("legacy/")) {
      const date = fragment.path.slice(0, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(fragment.path) ||
        Number.isNaN(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date
      ) {
        throw new Error(`${fragment.path}: use YYYY-MM-DD-<unique-slug>.md with a valid date`);
      }
      const fields = new Map<string, string>();
      for (const field of ["What happened", "Root cause", "Error class", "Guard"]) {
        const value = fragmentProse
          .split("\n")
          .find((line) => line.startsWith(`- **${field}:** `))
          ?.slice(field.length + 8)
          .trim();
        if (!value) {
          throw new Error(`${fragment.path}: missing ${field} field`);
        }
        fields.set(field, value);
      }
      classes.push(
        `| ${["Error class", "What happened", "Guard"].map((field) => fields.get(field)?.replace(/(?<!\\)\|/g, "\\|")).join(" | ")} |`,
      );
    }
    lessons.push(fragment);
  }

  const replacements = [
    [
      "<!-- lesson-classes -->",
      ["| Class | What goes wrong | Recorded guard |", "| --- | --- | --- |", ...classes.toSorted((a, b) => a.localeCompare(b))].join("\n"),
    ],
    [
      "<!-- lesson-entries -->",
      orderLessons(lessons)
        .map((entry) => entry.body.trim())
        .join("\n\n"),
    ],
  ];
  for (const [marker, content] of replacements) {
    if (template.split(marker).length !== 2) throw new Error(`lessons-learned.md must contain exactly one ${marker}`);
    template = template.replace(marker, () => content);
  }
  return template;
}
