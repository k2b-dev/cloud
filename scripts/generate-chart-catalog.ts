/**
 * Generates what the Assistant and Code read about each chart kind from the chart showcase examples
 * (`docs-site/src/ui/demo-sections/charts/examples/<kind>.ts`): when to use it, when not, its options and one small
 * valid description per kind and layout. The examples keep their first three entries per list, so the model reads a
 * short description of the same shape the showcase draws.
 *
 *   bun scripts/generate-chart-catalog.ts          write both files
 *   bun scripts/generate-chart-catalog.ts --check  exit 1 when one is stale
 *
 * `packages/cloud/src/ai/chart-catalog.test.ts` parses every example with the chart tool's schema and cloud.chart()'s;
 * the repository rule `chart-catalog` fails when a committed file differs from this output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chartShowcaseExamples } from "../docs-site/src/ui/demo-sections/charts/examples";
import type { ChartShowcaseExample, JsonValue } from "../docs-site/src/ui/demo-sections/charts/examples/types";
import { chartKindSchema } from "../packages/editor/src/chart-schema";

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
    return [...layouts.entries()].map(([layout, example]) => ({
      kind,
      ...(layout ? { layout } : {}),
      useFor: example.useFor,
      avoidFor: example.avoidFor,
      options: example.options,
      example: shorten(example.spec),
    }));
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
    "Each kind with when to use it, its options and one small valid description. Pass the",
    "same object to `cloud.chart()`, `await cloud.view.chart()` or the `chart` tool; every",
    "kind also takes `title`, `subtitle` and `tooltip` ([Charts](charts.md)).",
    "",
    ...entries.flatMap((entry) => [
      `## ${name(entry)}`,
      "",
      `Use for: ${entry.useFor.join(" ")}`,
      "",
      `Avoid for: ${entry.avoidFor.join(" ")}`,
      "",
      ...entry.options
        .filter((option) => !["title", "subtitle", "tooltip"].includes(option.name))
        .map((option) => `- \`${option.name}\` (${option.type}): ${option.description}`),
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
