/**
 * The Markdown of a UI topic page and its two placeholders.
 *
 * A topic page is one Markdown file. Two lines stand for live parts:
 *
 * - `<Example recipe="table" height="440" default="Rows" />` shows a recipe of the skill `k2b-ui` live;
 * - `<Props of="Table Column" />` shows the props of parts of `@k2b/ui/v2`, generated from their types.
 *
 * The page in the browser draws them as Fibel's `Example` and `Props`. Search, `read_doc` and llms.txt get the twin:
 * the same Markdown with each `Example` replaced by the recipe's path and its whole file in a code block, and each
 * `Props` by a Markdown table. A short front matter (`thumbnail`, `status`, `parts`) feeds the overview's map.
 */
import { type PropRow, type PropsDoc, recipeSource, recipesPath, v2Props } from "./build-results";
import { isRecipeName, type RecipeName, recipeStates } from "./recipes";

export type ExampleAttributes = { recipe: RecipeName; height: number; defaultLabel: string; width?: 1440 | 1024 | 390 };
export type TopicBlock =
  | { kind: "markdown"; text: string }
  | { kind: "example"; example: ExampleAttributes }
  | { kind: "props"; names: string[] };
export type TopicSubsection = { heading: string; blocks: TopicBlock[] };
export type TopicSectionKind = "example" | "choice" | "parts" | "missing" | "rules" | "next";
export type TopicSection = { heading: string; kind: TopicSectionKind; blocks: TopicBlock[]; subsections: TopicSubsection[] };
export type TopicFrontMatter = { thumbnail?: RecipeName; status?: "stub"; parts?: string };
export type ParsedTopic = { title: string; lead: string; front: TopicFrontMatter; sections: TopicSection[] };

const placeholder = /^<(Example|Props)\s+([^>]*?)\s*\/>\s*$/;
const attributes = (text: string) => Object.fromEntries([...text.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));

/** Fixed section headings; a heading ending in "?" is the choice ("List or table?"), every other one shows examples. */
const sectionKind = (heading: string): TopicSectionKind => {
  if (heading === "Parts") return "parts";
  if (heading === "Not in v2 yet") return "missing";
  if (heading === "Do and don't") return "rules";
  if (heading === "Next") return "next";
  if (heading.endsWith("?")) return "choice";
  return "example";
};

const exampleAttributes = (raw: Record<string, string>, line: string): ExampleAttributes => {
  const recipe = raw.recipe ?? "";
  if (!isRecipeName(recipe)) throw new Error(`Topic placeholder ${line}: no recipe "${recipe}" in docs-site/src/ui/topics/recipes.ts`);
  const width = raw.width === undefined ? undefined : Number(raw.width);
  if (width !== undefined && width !== 1440 && width !== 1024 && width !== 390)
    throw new Error(`Topic placeholder ${line}: width is 1440, 1024 or 390`);
  const height = Number(raw.height ?? 560);
  if (!Number.isFinite(height) || height < 200) throw new Error(`Topic placeholder ${line}: height is a number of px, at least 200`);
  return { recipe, height, defaultLabel: raw.default ?? "Default", width };
};

const propsNames = (raw: Record<string, string>, line: string) => {
  const names = (raw.of ?? "").split(/\s+/).filter(Boolean);
  const unknown = names.filter((name) => !v2Props[name]);
  if (names.length === 0 || unknown.length > 0)
    throw new Error(
      `Topic placeholder ${line}: ${unknown.length ? `no part or type ${unknown.join(", ")} in @k2b/ui/v2` : "of names no part"}`,
    );
  return names;
};

const frontMatter = (markdown: string): { front: TopicFrontMatter; body: string } => {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { front: {}, body: markdown };
  const fields = Object.fromEntries(
    match[1]!
      .split("\n")
      .map((line) => line.match(/^(\w+):\s*(.*)$/))
      .filter((found) => found !== null)
      .map((found) => [found[1]!, found[2]!.trim()]),
  );
  const thumbnail = fields.thumbnail;
  if (thumbnail !== undefined && !isRecipeName(thumbnail))
    throw new Error(`Topic front matter: no recipe "${thumbnail}" for the thumbnail`);
  if (fields.status !== undefined && fields.status !== "stub") throw new Error(`Topic front matter: status is "stub" or left out`);
  return {
    front: { thumbnail, status: fields.status === "stub" ? "stub" : undefined, parts: fields.parts },
    body: markdown.slice(match[0].length),
  };
};

/** Splits Markdown into prose and placeholders, never inside a code block. */
const blocksOf = (lines: readonly string[]): TopicBlock[] => {
  const blocks: TopicBlock[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const text = prose.join("\n").trim();
    if (text) blocks.push({ kind: "markdown", text });
    prose = [];
  };
  for (const line of lines) {
    const opener = line.match(/^(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (line.startsWith(fence)) fence = undefined;
      prose.push(line);
      continue;
    }
    if (opener) {
      fence = opener;
      prose.push(line);
      continue;
    }
    const found = line.match(placeholder);
    if (!found) {
      prose.push(line);
      continue;
    }
    flush();
    const raw = attributes(found[2]!);
    blocks.push(
      found[1] === "Example" ? { kind: "example", example: exampleAttributes(raw, line) } : { kind: "props", names: propsNames(raw, line) },
    );
  }
  flush();
  return blocks;
};

/** Splits lines at headings of one depth, never inside a code block. */
const splitAt = (lines: readonly string[], marker: "## " | "### ") => {
  const head: string[] = [];
  const parts: { heading: string; lines: string[] }[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const opener = line.match(/^(`{3,}|~{3,})/)?.[1];
    if (fence && line.startsWith(fence)) fence = undefined;
    else if (!fence && opener) fence = opener;
    else if (!fence && line.startsWith(marker)) {
      parts.push({ heading: line.slice(marker.length).trim(), lines: [] });
      continue;
    }
    (parts.at(-1)?.lines ?? head).push(line);
  }
  return { head, parts };
};

/** Reads a topic file: its title (`# …`), its lead, its front matter and its sections. Throws on a wrong placeholder. */
export const parseTopic = (markdown: string): ParsedTopic => {
  const { front, body } = frontMatter(markdown);
  const lines = body.split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("# "));
  if (titleIndex < 0) throw new Error("A topic page starts with its title as `# …`");
  const title = lines[titleIndex]!.slice(2).trim();
  const { head, parts } = splitAt(lines.slice(titleIndex + 1), "## ");
  const sections = parts.map(({ heading, lines: sectionLines }): TopicSection => {
    const kind = sectionKind(heading);
    if (kind === "example") return { heading, kind, blocks: blocksOf(sectionLines), subsections: [] };
    const split = splitAt(sectionLines, "### ");
    return {
      heading,
      kind,
      blocks: blocksOf(split.head),
      subsections: split.parts.map((part) => ({ heading: part.heading, blocks: blocksOf(part.lines) })),
    };
  });
  return { title, lead: head.join("\n").trim(), front, sections };
};

/** The first sentence of the lead, as the page's description and the overview's line. */
export const topicSummary = (topic: ParsedTopic) =>
  (topic.lead.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").match(/^(.+?[.!?])(\s|$)/)?.[1] ?? topic.lead;

/** The parts the topic names under "Parts", or the front matter's `parts` while the topic is a stub. */
export const topicParts = (topic: ParsedTopic) =>
  topic.sections.find((section) => section.kind === "parts")?.subsections.map((part) => part.heading) ??
  (topic.front.parts?.split("·").map((part) => part.trim()) || []);

/**
 * The fixed shape of a finished topic page, in this order: examples (at least one `Example`), at most one choice,
 * "Parts" (each part with a line), "Not in v2 yet", "Do and don't" (a `### Do` and a `### Don't` list, at most four
 * points each) and "Next". A stub is exempt.
 */
export const topicShapeProblems = (topic: ParsedTopic): string[] => {
  if (topic.front.status === "stub") return [];
  const problems: string[] = [];
  if (!topic.lead) problems.push("no lead: one or two sentences under the title say when to use this");
  const order: TopicSectionKind[] = ["example", "choice", "parts", "missing", "rules", "next"];
  let last = 0;
  for (const section of topic.sections) {
    const at = order.indexOf(section.kind);
    if (at < last) problems.push(`"${section.heading}" stands after a later section; the order is ${order.join(", ")}`);
    last = Math.max(last, at);
  }
  const count = (kind: TopicSectionKind) => topic.sections.filter((section) => section.kind === kind).length;
  if (!topic.sections.some((section) => section.kind === "example" && section.blocks.some((block) => block.kind === "example")))
    problems.push("no live example: an example section needs an <Example recipe=… />");
  if (count("choice") > 1) problems.push("more than one choice section");
  for (const kind of ["parts", "missing", "rules", "next"] as const)
    if (count(kind) !== 1)
      problems.push(
        `needs exactly one section "${{ parts: "Parts", missing: "Not in v2 yet", rules: "Do and don't", next: "Next" }[kind]}"`,
      );
  const parts = topic.sections.find((section) => section.kind === "parts");
  for (const part of parts?.subsections ?? [])
    if (!part.blocks.some((block) => block.kind === "markdown")) problems.push(`part ${part.heading} has no line that says what it is`);
  const rules = topic.sections.find((section) => section.kind === "rules");
  for (const side of ["Do", "Don't"]) {
    const list = rules?.subsections.find((sub) => sub.heading === side);
    if (rules && !list) problems.push(`"Do and don't" needs a "### ${side}"`);
    const points =
      list?.blocks.flatMap((block) => (block.kind === "markdown" ? block.text.split("\n").filter((line) => /^[-*] /.test(line)) : [])) ??
      [];
    if (list && (points.length === 0 || points.length > 4)) problems.push(`"### ${side}" has ${points.length} points; give 1 to 4`);
  }
  return problems;
};

const fenceFor = (source: string) => "`".repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map((match) => match[0].length + 1)));
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The states of a recipe as the Example offers them: the default first, then the file's states in order. */
export const exampleStates = (example: ExampleAttributes) => [
  { value: "", label: example.defaultLabel },
  ...Object.keys(recipeStates(example.recipe)).map((name) => ({ value: name, label: name.charAt(0).toUpperCase() + name.slice(1) })),
];

/** The recipe file and what it is, from its first comment line (`// Recipe: …`). */
export const recipeFile = (recipe: RecipeName) => {
  const source = recipeSource[recipe] ?? "";
  const about = source.match(/^\/\/ Recipe: (.+)$/m)?.[1]?.trim() ?? recipe;
  return { source, path: `${recipesPath}/${recipe}.tsx`, about };
};

const exampleMarkdown = (example: ExampleAttributes) => {
  const { source, path } = recipeFile(example.recipe);
  const states = Object.keys(recipeStates(example.recipe));
  const fence = fenceFor(source);
  return [`\`${path}\`${states.length ? ` (states: ${states.join(", ")})` : ""}`, "", `${fence}tsx`, source.trimEnd(), fence].join("\n");
};

const propRows = (rows: readonly PropRow[]) =>
  rows.map((row) => `| \`${row.name}\`${row.required ? " (required)" : ""} | \`${cell(row.type)}\` | ${cell(row.description) || "–"} |`);

/** One props table as Markdown: shared props, then a table per variant. */
export const propsMarkdown = (doc: PropsDoc) => {
  const head = ["| Prop | Type | What it does |", "| --- | --- | --- |"];
  const lines = [`#### \`${doc.title}\` props`, "", `From the types in \`${doc.file}\`.`, "", ...head, ...propRows(doc.rows)];
  for (const group of doc.groups) lines.push("", `${group.title}:`, "", ...head, ...propRows(group.rows));
  return lines.join("\n");
};

/** The Markdown twin of a topic page for search, `read_doc` and llms.txt: placeholders become code and tables. */
export const topicMarkdown = (markdown: string) => {
  parseTopic(markdown);
  const { body } = frontMatter(markdown);
  let fence: string | undefined;
  return body
    .split("\n")
    .map((line) => {
      const opener = line.match(/^(`{3,}|~{3,})/)?.[1];
      if (fence) {
        if (line.startsWith(fence)) fence = undefined;
        return line;
      }
      if (opener) {
        fence = opener;
        return line;
      }
      const found = line.match(placeholder);
      if (!found) return line;
      const raw = attributes(found[2]!);
      if (found[1] === "Example") return exampleMarkdown(exampleAttributes(raw, line));
      return propsNames(raw, line)
        .map((name) => propsMarkdown(v2Props[name]!))
        .join("\n\n");
    })
    .join("\n");
};
