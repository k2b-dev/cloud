/**
 * Generates what the Assistant and Code read about each chart kind from the chart showcase examples
 * (`docs-site/src/ui/demo-sections/charts/examples/<kind>.ts`): when to use it, when not, its options and one small
 * valid description per kind and layout. The examples keep their first three entries per list, so the model reads a
 * short description of the same shape the showcase draws.
 *
 *   bun scripts/generate-chart-catalog.ts          write both files
 *   bun scripts/generate-chart-catalog.ts --check  exit 1 when one is stale
 *
 * Every text is written for one surface: the Code reference for `cloud.chart()` (the application schema), the chart
 * tool's lines for the chat (its schema with limits). Options the surface's schema does not have are left out, enum
 * types come from the schema, and `chartCatalogIssues` reports any option, enum value or `name: "value"` the text
 * mentions that the surface does not accept.
 *
 * `packages/cloud/src/ai/chart-catalog.test.ts` parses every example with the chart tool's schema and cloud.chart()'s;
 * the repository rule `chart-catalog` fails on any issue and when a committed file differs from this output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chartShowcaseExamples } from "../docs-site/src/ui/demo-sections/charts/examples";
import type { ChartShowcaseExample, JsonValue } from "../docs-site/src/ui/demo-sections/charts/examples/types";
import { schemaShape, schemaValues } from "../docs-site/src/ui/demo-sections/charts/guidance";
import { chartKindSchema, chartKinds } from "../packages/editor/src/chart-schema";

/**
 * The schema each text is written for. The chat's limits change sizes and where a missing value may be null; they
 * name the same fields (the chart tool's own limits are in packages/cloud/src/ai/default-tool-contracts.ts).
 */
const surfaces = { code: chartKinds(), chat: chartKinds({ maxSeries: 8, maxValues: 480, maxMarks: 3840 }) };
type Surface = keyof typeof surfaces;

type Def = { type?: string; [key: string]: unknown };
const defOf = (schema: unknown): Def | undefined => (schema as { def?: Def } | null | undefined)?.def;
const wrappers = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional"]);
/** The strings a field accepts when it is an enum, a literal or a union of them; null when it takes any value. */
const accepted = (field: unknown): Set<string> | null => {
  const def = defOf(field);
  if (!def) return null;
  if (wrappers.has(def.type ?? "")) return accepted(def.innerType);
  if (def.type === "enum") return new Set(Object.values(def.entries as Record<string, unknown>).map(String));
  if (def.type === "literal") return new Set((def.values as unknown[]).map(String));
  if (def.type === "union") {
    const all = (def.options as unknown[]).map(accepted);
    return all.every((values) => values) ? new Set(all.flatMap((values) => [...values!])) : null;
  }
  return null;
};
type Fields = Map<string, Set<string> | null>;
/** Every field name in a schema branch, nested ones too, with the strings it accepts. */
const fieldsOf = (schema: unknown, into: Fields = new Map()): Fields => {
  const def = defOf(schema);
  if (!def) return into;
  if (def.type === "object") {
    for (const [name, field] of Object.entries(def.shape as Record<string, unknown>)) {
      const values = accepted(field);
      const known = into.get(name);
      into.set(name, into.has(name) && (known === null || values === null) ? null : new Set([...(known ?? []), ...(values ?? [])]));
      fieldsOf(field, into);
    }
  } else if (def.type === "array") fieldsOf(def.element, into);
  else if (def.type === "union") for (const option of def.options as unknown[]) fieldsOf(option, into);
  else if (def.type === "pipe") fieldsOf(def.in, into), fieldsOf(def.out, into);
  else if (wrappers.has(def.type ?? "")) fieldsOf(def.innerType, into);
  return into;
};
/** The top-level option names an option line documents: `data[].size` is `data`, `a, b` is both. */
const roots = (name: string) => name.split(", ").map((part) => part.split(/[.[]/)[0]!);
/** A description that says a missing value may be null, not one that rules null out. */
const promisesNull = (text: string) => /\bnull\b/.test(text) && !/null is rejected|\bno null\b|\bnot null\b/i.test(text);
/** `name: "value"`, `name: true` or `name: null` in prose, outside JSON (whose keys are quoted): always a field. */
const mentions = (text: string) =>
  [...text.matchAll(/(?<![\w"])`?([A-Za-z]\w*)`?: ("([^"]*)"|true|false|null)/g)].map((match) => ({ name: match[1]!, value: match[3] }));

/** The two generated files, relative to the repository root. */
export const chartCatalogTargets = {
  tool: "packages/cloud/src/ai/chart-catalog.generated.ts",
  code: "packages/assistant/src/skills/assistant-code-mode/references/chart-kinds.md",
} as const;

const KEEP = 3;
const shorten = (value: JsonValue): JsonValue =>
  Array.isArray(value)
    ? value.slice(0, KEEP).map(shorten)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry)]))
      : value;

type Entry = {
  kind: string;
  layout?: string;
  useFor: string[];
  avoidFor: string[];
  options: ChartShowcaseExample["options"];
  example: JsonValue;
};

/** Per chart kind of the portable schema: its lead example, and one more for each further `layout` it shows. */
export const chartCatalogEntries = (examples: readonly ChartShowcaseExample[] = chartShowcaseExamples): Entry[] =>
  chartKindSchema().options.flatMap((kind) => {
    const own = examples.filter((example) => example.kind === kind || (example.spec as { kind?: string } | null)?.kind === kind);
    const ordered = [...own.filter((example) => example.lead), ...own.filter((example) => !example.lead)];
    const layouts = new Map<string, ChartShowcaseExample>();
    for (const example of ordered) {
      const layout = (example.spec as { layout?: string }).layout ?? "";
      if (!layouts.has(layout)) layouts.set(layout, example);
    }
    return [...layouts.entries()].map(([layout, example]) => {
      const spec = shorten(example.spec);
      const shape = schemaShape(kind, layout || undefined, surfaces.code) ?? {};
      return {
        kind,
        ...(layout ? { layout } : {}),
        useFor: example.useFor,
        avoidFor: example.avoidFor,
        // Options of cloud.chart() in this build (title, subtitle and tooltip are named once for every kind), with the
        // values the schema accepts and where the chat needs a number instead of null.
        options: example.options
          .filter((option) => !["title", "subtitle", "tooltip"].includes(option.name))
          .filter((option) => roots(option.name).every((root) => root in shape))
          .map((option) => {
            const values = /^\w+$/.test(option.name) ? schemaValues(kind, option.name, layout || undefined) : undefined;
            const typed = values ? { ...option, type: values.map((value) => JSON.stringify(value)).join(" | ") } : option;
            return promisesNull(option.description) && !nullAccepted(spec, roots(option.name)[0]!, "chat")
              ? { ...typed, description: `${typed.description} Views and the chart tool need a number here.` }
              : typed;
          }),
        example: spec,
      };
    });
  });

/** The example with its first number under `root` set to null, or undefined when it holds no number there. */
const withNull = (spec: JsonValue, root: string): JsonValue | undefined => {
  let done = false;
  const walk = (value: JsonValue): JsonValue => {
    if (done) return value;
    if (typeof value === "number") {
      done = true;
      return null;
    }
    if (Array.isArray(value)) return value.map(walk);
    return value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]))
      : value;
  };
  const object = spec as Record<string, JsonValue>;
  const changed = { ...object, [root]: walk(object[root] ?? null) };
  return done ? changed : undefined;
};
/** Whether a surface draws the example with a missing (null) value where its option says one may be null. */
const nullAccepted = (spec: JsonValue, root: string, surface: Surface) => {
  const changed = withNull(spec, root);
  return changed === undefined || surfaces[surface].safeParse(changed).success;
};

/**
 * What each text mentions that the schema of its surface does not accept: an option that is no field of the kind, an
 * enum value it does not take, a `name: "value"` in prose (such as `marks: "dots"` before dot matrices exist), or a
 * null the Code reference promises where cloud.chart() rejects it.
 */
export const chartCatalogIssues = (entries: Entry[] = chartCatalogEntries()): string[] =>
  entries.flatMap((entry) => {
    const check = (surface: Surface, texts: string[], options: Entry["options"]) => {
      const shape = schemaShape(entry.kind, entry.layout, surfaces[surface]);
      if (!shape) return [`${name(entry)}: no ${surface} chart kind`];
      const fields = fieldsOf({ def: { type: "object", shape } });
      const issues: string[] = [];
      for (const option of options) {
        const [root] = roots(option.name);
        for (const part of roots(option.name)) if (!(part in shape)) issues.push(`${name(entry)}, ${surface}: option ${part} is no field`);
        if (/^"[^"]*"( \| "[^"]*")*$/.test(option.type))
          for (const [, value] of option.type.matchAll(/"([^"]*)"/g))
            if (!fields.get(root!)?.has(value!)) issues.push(`${name(entry)}, ${surface}: ${option.name} does not take "${value}"`);
        if (promisesNull(option.description) && !nullAccepted(entry.example, root!, surface))
          issues.push(`${name(entry)}, ${surface}: ${option.name} does not take null`);
      }
      for (const text of [...texts, ...options.map((option) => option.description)])
        for (const mention of mentions(text)) {
          const values = fields.get(mention.name);
          if (!fields.has(mention.name)) issues.push(`${name(entry)}, ${surface}: "${mention.name}" is no field`);
          else if (mention.value !== undefined && values && !values.has(mention.value))
            issues.push(`${name(entry)}, ${surface}: ${mention.name} does not take "${mention.value}"`);
        }
      return issues;
    };
    return [
      ...check("code", [...entry.useFor, ...entry.avoidFor], entry.options),
      ...check("chat", [entry.useFor[0] ?? "", entry.avoidFor[0] ?? ""], []),
    ];
  });

const header = "Generated from the chart showcase examples by scripts/generate-chart-catalog.ts. Do not edit.";
/** The chart tool's example without `subtitle` and `tooltip`, which its description names once for every kind. */
const toolExample = (example: JsonValue) =>
  Object.fromEntries(Object.entries(example as Record<string, JsonValue>).filter(([key]) => key !== "subtitle" && key !== "tooltip"));
const name = (entry: Entry) => (entry.layout ? `${entry.kind} (layout "${entry.layout}")` : entry.kind);

const repository = join(import.meta.dir, "..");
/** The text as the repository's Biome formats it, so the committed file passes the `biome` rule unchanged. */
const formatted = async (path: string, text: string) => {
  const child = Bun.spawn([join(repository, "node_modules", ".bin", "biome"), "format", `--stdin-file-path=${path}`], {
    cwd: repository,
    stdin: new Blob([text]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`biome format ${path} failed: ${err || out}`);
  return out;
};

/** Both generated files, keyed by their path relative to the repository root. */
export const chartCatalogSources = async (entries: Entry[] = chartCatalogEntries()): Promise<Record<string, string>> => {
  const tool = [
    `// ${header}`,
    "",
    "/** One line per chart kind and layout for the chart tool: when to use it, when not, and a small valid description. */",
    "export const chartCatalog = [",
    ...entries.map(
      (entry) =>
        `  { name: ${JSON.stringify(name(entry))}, useFor: ${JSON.stringify(entry.useFor[0] ?? "")}, avoidFor: ${JSON.stringify(entry.avoidFor[0] ?? "")}, example: ${JSON.stringify(toolExample(entry.example))} },`,
    ),
    "] as const;",
    "",
  ].join("\n");
  const code = [
    `<!-- ${header} -->`,
    "",
    "# Chart kinds",
    "",
    "Each kind with when to use it, its options and one small valid description. The",
    "options are those of `cloud.chart()` in apps, scripts and PDFs; every kind also takes",
    "`title`, `subtitle` and `tooltip` ([Charts](charts.md)). `await cloud.view.chart()`",
    "and the `chart` tool take the same descriptions within the chat's limits: labels are",
    "text, lists are shorter ([Views in the chat](views.md)), and an option notes where they",
    "need a number instead of null. Every example below is valid on all three.",
    "",
    ...entries.flatMap((entry) => [
      `## ${name(entry)}`,
      "",
      `Use for: ${entry.useFor.join(" ")}`,
      "",
      `Avoid for: ${entry.avoidFor.join(" ")}`,
      "",
      ...entry.options.map((option) => `- \`${option.name}\` (${option.type}): ${option.description}`),
      "",
      "```json",
      JSON.stringify(entry.example),
      "```",
      "",
    ]),
  ].join("\n");
  return { [chartCatalogTargets.tool]: await formatted(chartCatalogTargets.tool, tool), [chartCatalogTargets.code]: code };
};

/** Paths whose committed text differs from the generated one. */
export const staleChartCatalog = (root: string, sources: Record<string, string>): string[] =>
  Object.entries(sources)
    .filter(([path, text]) => {
      try {
        return readFileSync(join(root, path), "utf8") !== text;
      } catch {
        return true;
      }
    })
    .map(([path]) => path);

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: bun scripts/generate-chart-catalog.ts [--check]\nWrites the chart kind catalog for the chart tool and Code from the showcase examples.",
    );
    process.exit(0);
  }
  const sources = await chartCatalogSources();
  const stale = staleChartCatalog(repository, sources);
  if (process.argv.includes("--check")) {
    if (stale.length) console.error(`Stale: ${stale.join(", ")}. Run \`bun scripts/generate-chart-catalog.ts\`.`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const path of stale) writeFileSync(join(repository, path), sources[path]!);
  console.log(stale.length ? `Updated ${stale.join(", ")}` : "The chart catalog is current");
}
