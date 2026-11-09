import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { chartCatalogEntries, chartCatalogIssues, chartCatalogSources, chartCatalogTargets } from "../generate-chart-catalog";
import { rule } from "./chart-catalog";

const sources = await chartCatalogSources();

/** A repository holding the given catalog files; returns the findings and the files after the run. */
const check = async (files: Record<string, string>, fix = false) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-chart-catalog-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const findings = await rule.run({ workspaceRoot: root, fix, flags: new Set() });
    return {
      findings: findings.map((finding) => relative(root, finding.file ?? "")),
      tool: await readFile(join(root, chartCatalogTargets.tool), "utf8").catch(() => undefined),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a catalog generated from the showcase examples passes", async () => {
  expect((await check(sources)).findings).toEqual([]);
});

test("an edited or missing catalog file is reported, and --fix writes the generated one", async () => {
  const edited = { ...sources, [chartCatalogTargets.tool]: sources[chartCatalogTargets.tool]!.replace('"bar"', '"bars"') };
  expect((await check(edited)).findings).toEqual([chartCatalogTargets.tool]);
  expect((await check({ [chartCatalogTargets.tool]: sources[chartCatalogTargets.tool]! })).findings).toEqual([chartCatalogTargets.code]);
  expect(await check(edited, true)).toEqual({ findings: [], tool: sources[chartCatalogTargets.tool] });
});

test("the catalog has an entry for every kind with its reasons and a description of that kind", () => {
  const tool = sources[chartCatalogTargets.tool]!;
  for (const kind of ["waterfall", "area", "bar", "hbar", "funnel", "line", "scatter", "pie", "donut", "histogram", "gauge"])
    expect(tool).toContain(`kind: "${kind}"`);
  expect(sources[chartCatalogTargets.code]).toContain('## heatmap (layout "calendar")');
});

test("the catalog of this build mentions only what each surface's schema accepts", () => {
  expect(chartCatalogIssues()).toEqual([]);
  // The chat needs numbers where cloud.chart() takes null; the Code reference says so at the option.
  const line = chartCatalogEntries().find((entry) => entry.kind === "line")!;
  expect(line.options.find((option) => option.name === "series")!.description).toContain("Views and the chart tool need a number here.");
  const area = chartCatalogEntries().find((entry) => entry.kind === "area")!;
  expect(area.options.map((option) => option.description).join(" ")).not.toContain("Views and the chart tool need a number");
});

test("an option, an enum value or a null the schema does not take is an issue for its surface", () => {
  const entries = chartCatalogEntries();
  const bar = entries.find((entry) => entry.kind === "bar" && !entry.layout)!;
  const waterfall = entries.find((entry) => entry.kind === "waterfall")!;
  const wrong = [
    {
      ...bar,
      // The text promises a field and a layout value the schema lacks.
      useFor: ['Nested bars as hexagons with shape: "hexagons".'],
      options: [...bar.options, { name: "layout", type: '"columns" | "hexagons"', description: "Rows or columns." }],
    },
    { ...waterfall, options: [{ name: "steps", type: "{ label, value }[]", description: "A missing step is null." }] },
  ];
  expect(chartCatalogIssues(wrong)).toEqual([
    'bar, code: layout does not take "hexagons"',
    'bar, code: "shape" is no field',
    'bar, chat: "shape" is no field',
    "waterfall, code: steps does not take null",
  ]);
});
