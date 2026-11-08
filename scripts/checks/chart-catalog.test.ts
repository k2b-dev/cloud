import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { chartCatalogSources, chartCatalogTargets } from "../generate-chart-catalog";
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
