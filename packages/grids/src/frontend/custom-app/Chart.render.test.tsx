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
  // A full-width block would otherwise draw a 480:280 SVG far taller than the block and overlap the next one.
  expect(chart(statuses, { chartType: "donut" })).toMatch(/^<div class="flex h-72 flex-col"><div class="k2b-chart min-h-0 flex-1"/);
  for (const chartType of ["bar", "line"] as const) {
    expect(chart(statuses, { chartType })).toMatch(
      /^<div class="flex h-72 flex-col"><div class="flex min-h-0 flex-1"><span [^>]*data-chart-y-tick-gutter><\/span><div class="k2b-chart min-w-0 flex-1 /,
    );
  }
});

test("bar and line charts show the y-axis label beside the plot and the x-axis label below their categories", () => {
  for (const chartType of ["bar", "line"] as const) {
    const yAxisLabel = "Average handling time in working days per ticket status";
    const html = chart(statuses, { chartType, xAxisLabel: "Ticket status", yAxisLabel });
    // stdlib would draw both labels at full length inside the SVG: a long y-axis label runs past
    // the chart's fixed height and over wide value labels, and its bar chart has no x-axis label.
    expect(html).not.toContain(`<text class="stdlib-chart-axis-label"`);
    const side = html.match(
      /^<div class="flex h-72 flex-col"><div class="flex min-h-0 flex-1">(<p[^>]*>[^<]*<\/p>)(<span [^>]*data-chart-y-tick-gutter><\/span>)<div class="k2b-chart /,
    );
    expect(side?.[1]).toMatch(/^<p class="w-4 [^"]*\brotate-180\b[^"]*\btruncate\b[^"]*" style="writing-mode:vertical-rl;/);
    expect(side?.[1]).toContain(`title="${yAxisLabel}" data-chart-y-axis-label>${yAxisLabel}</p>`);
    // The axis below is indented by the label's width and the same tick gutter, so its percentages refer to the chart's own width.
    const { width, start, end } = plotArea(html);
    const bottom = html.match(
      /<\/div><div class="flex shrink-0"><span class="w-4 shrink-0"><\/span>(<span [^>]*><\/span>)<div class="min-w-0 flex-1"><div class="relative[^"]*">.*<\/div>(<p[^>]*>Ticket status<\/p>)<\/div><\/div><\/div>$/,
    );
    expect(bottom?.[1]).toBe(side?.[2]);
    const below = bottom?.[2];
    expect(below).toContain("data-chart-x-axis-label");
    expect(below).toContain(`padding-left:${(start / width) * 100}%`);
    expect(below).toContain(`padding-right:${((width - end) / width) * 100}%`);
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

test("the lowest value label keeps room below its baseline for descenders such as the g in kg", () => {
  for (const chartType of ["bar", "line"] as const) {
    const html = chart(statuses, { chartType, valueFormat: { style: "number", unit: "kg" }, xAxisLabel: "Ticket status" });
    const height = Number(html.match(/viewBox="0 0 \d+ (\d+)"/)?.[1]);
    const baselines = [
      ...html.matchAll(/<text class="stdlib-chart-tick-label"[^>]*y="([\d.]+)"[^>]*text-anchor="end"[^>]*>[^<]* kg<\/text>/g),
    ].map((tick) => Number(tick[1]));
    expect(baselines.length).toBeGreaterThan(1);
    // The SVG clips its content. Its 10px labels descend about 3px, and the SVG is drawn
    // slightly shorter than its viewBox, so 4 units of room are needed below the baseline.
    expect(height - Math.max(...baselines)).toBeGreaterThanOrEqual(4);
  }
});

test("charts without renderable values keep the chart's empty state without an axis", () => {
  for (const chartType of ["bar", "line"] as const) {
    const html = chart([], { chartType, xAxisLabel: "Ticket status", yAxisLabel: "Tickets" });
    expect(html).toContain("k2b-chart__empty");
    expect(html).not.toContain("data-chart-x-axis-label");
    expect(html).not.toContain("data-chart-y-axis-label");
    expect(html).not.toContain("data-chart-category");
  }
});

const amounts = (values: number[], props: Partial<ChartProps> = {}): string =>
  chart([], {
    data: {
      kind: "chart",
      buckets: values.map((value, index) => ({ keys: [`Category ${index + 1}`], values: { amount__sum: String(value) } })),
      fields: [],
      viewQuery: { groupBy: [{ fieldId: "category" }], aggregations: [{ fieldId: "amount", agg: "sum" }] },
      relationLabels: {},
    },
    ...props,
  });

// Axis text is a 10px monospace font, so every character is 1ch wide; 6px is typical.
const CHAR_PX = 6;

/**
 * Where the y tick labels and the plot start, in CSS pixels, when the chart block is
 * `blockWidth` pixels wide. The plot stretches with the block; text keeps its pixel size.
 */
const yAxisLayout = (html: string, blockWidth: number) => {
  const { width, start } = plotArea(html);
  const yAxisLabelPx = html.includes("data-chart-y-axis-label") ? 16 : 0;
  const gutterPx = Number(html.match(/<span[^>]*data-chart-y-tick-gutter[^>]*>/)?.[0].match(/width:\s*([\d.]+)ch/)?.[1] ?? 0) * CHAR_PX;
  const svgLeft = yAxisLabelPx + gutterPx;
  const scale = (blockWidth - svgLeft) / width;
  const labels = [...html.matchAll(/<text class="stdlib-chart-tick-label" x="(-?[\d.]+)"[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map(
    ([, x, text]) => {
      const end = svgLeft + Number(x) * scale;
      return { text: text!, left: end - [...text!].length * CHAR_PX, end };
    },
  );
  return { yAxisLabelPx, labels, plotStart: svgLeft + start * scale };
};

test("y-axis values stay whole and close to the plot on phones and wide pages alike", () => {
  const cases: { locale: string; values: number[]; valueFormat: NonNullable<ChartProps["valueFormat"]>; shows: string }[] = [
    {
      locale: "de",
      values: [3200.5, 14250, 9870.25, 15100],
      valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR" },
      shows: "10.000,00 EUR",
    },
    {
      locale: "en",
      values: [3200.5, 14250, 9870.25, 15100],
      valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR", unitPosition: "prefix" },
      shows: "EUR 10,000.00",
    },
    {
      locale: "de",
      values: [-4200, 1250.75, 980],
      valueFormat: { style: "number", decimalPlaces: 2, unit: "kWh" },
      shows: "-5.000,00 kWh",
    },
    { locale: "en", values: [0.25, 0.5, 0.125], valueFormat: { style: "percent" }, shows: "50%" },
    { locale: "en", values: [3, 7, 12], valueFormat: undefined, shows: "12" },
  ];
  for (const { locale, values, valueFormat, shows } of cases) {
    for (const chartType of ["bar", "line"] as const) {
      for (const yAxisLabel of [undefined, "Amount"]) {
        const html = amounts(values, { chartType, valueFormat, yAxisLabel, dateConfig: { timeZone: "UTC", locale } });
        // A 390px phone, a tablet, and a full-width block on a 1440px page.
        for (const blockWidth of [342, 600, 1140]) {
          const { yAxisLabelPx, labels, plotStart } = yAxisLayout(html, blockWidth);
          expect(labels.map((label) => label.text)).toContain(shows);
          const context = `${chartType} ${locale} ${shows} at ${blockWidth}px`;
          for (const label of labels) {
            expect({ context, text: label.text, clipped: label.left < yAxisLabelPx }).toEqual({
              context,
              text: label.text,
              clipped: false,
            });
            expect(label.end).toBeLessThanOrEqual(plotStart);
          }
          // The gutter fits the widest label instead of a fixed share of the width.
          const widestPx = Math.max(...labels.map((label) => label.end - label.left));
          expect(plotStart - yAxisLabelPx - widestPx).toBeLessThanOrEqual(16);
        }
      }
    }
  }
});
