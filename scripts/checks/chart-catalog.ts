import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chartCatalogEntries, chartCatalogIssues, chartCatalogSources, staleChartCatalog } from "../generate-chart-catalog";
import type { Rule } from "./rule";

const showcase = "docs-site/src/ui/demo-sections/charts/examples";

/**
 * What the chart tool and Code tell the model about each chart kind is generated from the chart showcase examples;
 * a changed example or a new kind must reach both, so the committed text never describes another chart than the
 * showcase draws, and nothing in it names an option or value the schema of its surface rejects.
 */
export const rule: Rule = {
  name: "chart-catalog",
  description:
    "The chart tool's and Code's chart kind catalog matches the showcase examples and their schemas (bun scripts/generate-chart-catalog.ts; --fix writes it)",
  run: async ({ workspaceRoot, fix }) => {
    const entries = chartCatalogEntries();
    const issues = chartCatalogIssues(entries).map((issue) => ({
      file: join(workspaceRoot, showcase),
      message: `${issue}. Change the showcase example's text so it describes only what this build's schema accepts.`,
    }));
    const sources = await chartCatalogSources(entries);
    const stale = staleChartCatalog(workspaceRoot, sources);
    if (fix) for (const path of stale) writeFileSync(join(workspaceRoot, path), sources[path]!);
    return [
      ...issues,
      ...(fix ? [] : stale).map((path) => ({
        file: join(workspaceRoot, path),
        message: `${path} is not what the chart showcase examples generate. Run \`bun scripts/generate-chart-catalog.ts\` and commit the result.`,
      })),
    ];
  },
};
