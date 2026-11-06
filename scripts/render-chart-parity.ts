import { chartParityMarkdown } from "../packages/ui/src/charts/parity";

if (Bun.argv.includes("--help")) {
  console.log("Usage: bun scripts/render-chart-parity.ts\nRegenerate the chart parity table in the canonical UI context page.");
} else {
  const file = Bun.file(new URL("../docs-site/src/ui/context/content/charts.md", import.meta.url));
  const start = "<!-- chart-parity:start -->";
  const end = "<!-- chart-parity:end -->";
  const source = await file.text();
  const table = `${start}\n${chartParityMarkdown()}\n${end}`;
  const next = source.includes(start)
    ? source.slice(0, source.indexOf(start)) + table + source.slice(source.indexOf(end) + end.length)
    : `${source}\n## Renderer parity\n\nThe table tracks existing tests and demos for the port. Covered means the named proof exists and its SVG spec matches the old renderer; it does not mean every browser/consumer proof ran locally. Gaps block removal of the old path. Regenerate with \`bun scripts/render-chart-parity.ts\`.\n\n${table}\n`;
  await Bun.write(file, next);
}
