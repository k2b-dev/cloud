import { expect, test } from "bun:test";
import { type ComponentProps, createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../_components/ssr-test-plugin";

const { default: CustomAppChart } = await import("./Chart");

type ChartProps = ComponentProps<typeof CustomAppChart>;

const chart = (labels: string[], props: Partial<ChartProps> = {}): string =>
  renderToString(() =>
    createComponent(CustomAppChart, {
      chartType: "bar",
      dateConfig: { timeZone: "UTC", locale: "en" },
      data: {
        kind: "chart",
        buckets: labels.map((label, index) => ({ keys: [label], values: { "*__count": index + 1 } })),
        fields: [],
        viewQuery: { groupBy: [{ fieldId: "status" }], aggregations: [{ fieldId: "*", agg: "count" }] },
        relationLabels: {},
      },
      ...props,
    }),
  );

const statuses = ["New", "Waiting for customer response", "Done"];

/** The rendered plot area in the chart's own coordinate space. */
const plotArea = (html: string) => {
  const width = Number(html.match(/viewBox="0 0 (\d+) \d+"/)?.[1]);
  const xAxis = html.match(/<line class="stdlib-chart-axis" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="\2"\/>/);
  if (!width || !xAxis) throw new Error("Missing chart geometry");
  return { width, start: Number(xAxis[1]), end: Number(xAxis[3]) };
};

const categoryLabels = (html: string) =>
  [...html.matchAll(/<span[^>]*data-chart-category[^>]*>[^<]*<\/span>/g)].map(([tag]) => ({
    text: tag.match(/>([^<]*)<\/span>$/)?.[1],
    title: tag.match(/title="([^"]*)"/)?.[1],
    left: Number(tag.match(/left:\s*([\d.]+)%/)?.[1]),
    maxWidth: Number(tag.match(/max-width:\s*([\d.]+)%/)?.[1]),
  }));

const svgCategoryTicks = (html: string) =>
  [...html.matchAll(/<text class="stdlib-chart-tick-label"[^>]*text-anchor="middle"[^>]*>([^<]*)<\/text>/g)].map((tick) => tick[1]);

test("every chart type fills a fixed-height box instead of sizing itself by its aspect ratio", () => {
  for (const chartType of ["bar", "line", "donut"] as const) {
    const html = chart(statuses, { chartType });
    // A full-width block would otherwise draw a 480:280 SVG far taller than the block and overlap the next one.
    expect(html).toMatch(/^<div class="flex h-72 flex-col"><div class="k2b-chart min-h-0 flex-1"/);
  }
});

test("bar and line charts show the y-axis label in the chart and the x-axis label below their categories", () => {
  for (const chartType of ["bar", "line"] as const) {
    const html = chart(statuses, { chartType, xAxisLabel: "Ticket status", yAxisLabel: "Tickets" });
    expect(html).toMatch(/<text class="stdlib-chart-axis-label"[^>]*transform="rotate\(-90[^>]*>Tickets<\/text>/);
    // stdlib's bar chart has no x-axis label, and its line chart would draw it above our category names.
    expect(html).not.toContain(">Ticket status</text>");
    const { width, start, end } = plotArea(html);
    const caption = html.match(/<\/div><p[^>]*data-chart-x-axis-label[^>]*>Ticket status<\/p><\/div>$/)?.[0];
    expect(caption).toBeDefined();
    expect(caption).toContain(`padding-left:${(start / width) * 100}%`);
    expect(caption).toContain(`padding-right:${((width - end) / width) * 100}%`);
  }
});

test("category names sit under their bar or point and are shortened to their slot, keeping the full name as title", () => {
  for (const chartType of ["bar", "line"] as const) {
    for (const yAxisLabel of [undefined, "Tickets"]) {
      const html = chart(statuses, { chartType, yAxisLabel });
      // stdlib would draw each name at full length (line: repeated between points), overlapping on narrow blocks.
      expect(svgCategoryTicks(html).filter(Boolean)).toEqual([]);
      const { width, start, end } = plotArea(html);
      const slot = (end - start) / statuses.length;
      expect(categoryLabels(html)).toEqual(
        statuses.map((label, index) => ({
          text: label,
          title: label,
          left: ((start + (index + 0.5) * slot) / width) * 100,
          maxWidth: (slot / width) * 100,
        })),
      );
      expect(html).toMatch(/<span class="[^"]*\btruncate\b[^"]*"[^>]*data-chart-category/);
      if (chartType === "line") {
        // Points share the slot centres of the names below them.
        expect(html).toMatch(new RegExp(`class="stdlib-chart-line[^"]*" d="M ${Number((start + slot / 2).toFixed(2))} `));
      }
    }
  }
});

test("charts name at most 12 categories and give each shown name the room of the categories it stands for", () => {
  const labels = Array.from({ length: 30 }, (_, index) => `Week ${index + 1}`);
  for (const chartType of ["bar", "line"] as const) {
    const html = chart(labels, { chartType });
    const { width, start, end } = plotArea(html);
    const slot = (end - start) / labels.length;
    const shown = categoryLabels(html);
    expect(shown.map((label) => label.text)).toEqual(labels.filter((_, index) => index % 3 === 0));
    expect(shown[1]).toEqual({
      text: "Week 4",
      title: "Week 4",
      left: ((start + 3.5 * slot) / width) * 100,
      maxWidth: ((3 * slot) / width) * 100,
    });
  }
});

test("charts without renderable values keep the chart's empty state without an axis", () => {
  for (const chartType of ["bar", "line"] as const) {
    const html = chart([], { chartType, xAxisLabel: "Ticket status" });
    expect(html).toContain("k2b-chart__empty");
    expect(html).not.toContain("data-chart-x-axis-label");
    expect(html).not.toContain("data-chart-category");
  }
});
