import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chartCatalogSources, staleChartCatalog } from "../generate-chart-catalog";
import type { Rule } from "./rule";

/**
 * What the chart tool and Code tell the model about each chart kind is generated from the chart showcase examples;
 * a changed example or a new kind must reach both, so the committed text never describes another chart than the
 * showcase draws.
 */
export const rule: Rule = {
  name: "chart-catalog",
  description:
    "The chart tool's and Code's chart kind catalog matches the showcase examples (bun scripts/generate-chart-catalog.ts; --fix writes it)",
  run: async ({ workspaceRoot, fix }) => {
    const sources = await chartCatalogSources();
    const stale = staleChartCatalog(workspaceRoot, sources);
    if (fix) {
      for (const path of stale) writeFileSync(join(workspaceRoot, path), sources[path]!);
      return [];
    }
    return stale.map((path) => ({
      file: join(workspaceRoot, path),
      message: `${path} is not what the chart showcase examples generate. Run \`bun scripts/generate-chart-catalog.ts\` and commit the result.`,
    }));
  },
};
