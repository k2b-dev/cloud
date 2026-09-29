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

/** The y tick gutter, which holds the tick labels invisibly so the browser sizes it. */
const GUTTER = String.raw`<span [^>]*data-chart-y-tick-gutter>(?:<span[^>]*>[^<]*</span>)+</span>`;
const gutterLabels = (html: string) =>
  [...(html.match(new RegExp(GUTTER))?.[0].matchAll(/<span[^>]*>([^<]*)<\/span>/g) ?? [])].map((label) => label[1] ?? "");

const svgCategoryTicks = (html: string) =>
  [...html.matchAll(/<text class="stdlib-chart-tick-label"[^>]*text-anchor="middle"[^>]*>([^<]*)<\/text>/g)].map((tick) => tick[1]);

test("every chart type fills a fixed-height box instead of sizing itself by its aspect ratio", () => {
  // A full-width block would otherwise draw a 480:280 SVG far taller than the block and overlap the next one.
  expect(chart(statuses, { chartType: "donut" })).toMatch(/^<div class="flex h-72 flex-col"><div class="k2b-chart min-h-0 flex-1"/);
  for (const chartType of ["bar", "line"] as const) {
    expect(chart(statuses, { chartType })).toMatch(
      new RegExp(`^<div class="flex h-72 flex-col"><div class="flex min-h-0 flex-1">${GUTTER}<div class="k2b-chart flex-1 `),
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
      new RegExp(`^<div class="flex h-72 flex-col"><div class="flex min-h-0 flex-1">(<p[^>]*>[^<]*</p>)(${GUTTER})<div class="k2b-chart `),
    );
    expect(side?.[1]).toMatch(/^<p class="w-4 [^"]*\brotate-180\b[^"]*\btruncate\b[^"]*" style="writing-mode:vertical-rl;/);
    expect(side?.[1]).toContain(`title="${yAxisLabel}" data-chart-y-axis-label>${yAxisLabel}</p>`);
    // The axis below is indented by the label's width and the same tick gutter, and shares the
    // chart's minimum width, so its percentages refer to the chart's own width.
    const { width, start, end } = plotArea(html);
    const bottom = html.match(
      new RegExp(
        `</div><div class="flex shrink-0"><span class="w-4 shrink-0"></span>(${GUTTER})<div class="flex-1" style="([^"]*)"><div class="relative[^"]*">.*</div>(<p[^>]*>Ticket status</p>)</div></div></div>$`,
      ),
    );
    expect(bottom?.[1]).toBe(side?.[2]);
    expect(html).toContain(
      `<div class="k2b-chart flex-1 [&amp;_svg]:overflow-visible" data-chart-kind="${chartType}" style="${bottom?.[2]}"`,
    );
    const below = bottom?.[3];
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

// Axis text is a 10px monospace font, so Latin characters are 1ch wide; 6px is typical.
// Browsers size the gutter with the real glyphs, so wider ones need no model here.
const CHAR_PX = 6;
const REM_PX = 16;

/**
 * Where the y tick labels and the plot start, in CSS pixels, when the chart block is
 * `blockWidth` pixels wide. The plot stretches with the block down to its minimum
 * width; text keeps its pixel size, and the gutter is as wide as its widest label.
 */
const yAxisLayout = (html: string, blockWidth: number) => {
  const { width, start } = plotArea(html);
  const yAxisLabelPx = html.includes("data-chart-y-axis-label") ? 16 : 0;
  const gutterPx = Math.max(...gutterLabels(html).map((label) => [...label].length)) * CHAR_PX;
  const svgLeft = yAxisLabelPx + gutterPx;
  const plotMinPx = Number(html.match(/<div class="k2b-chart [^>]*style="min-width:([\d.]+)rem"/)?.[1]) * REM_PX;
  const plotPx = Math.max(blockWidth - svgLeft, plotMinPx);
  const scale = plotPx / width;
  const labels = [...html.matchAll(/<text class="stdlib-chart-tick-label" x="(-?[\d.]+)"[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map(
    ([, x, text]) => {
      const end = svgLeft + Number(x) * scale;
      return { text: text!, left: end - [...text!].length * CHAR_PX, end };
    },
  );
  return { yAxisLabelPx, labels, plotStart: svgLeft + start * scale, plotPx, chartEnd: svgLeft + plotPx };
};

test("y-axis values stay whole and close to the plot on phones and wide pages alike", () => {
  const cases: { locale: string; values: number[]; valueFormat: ChartProps["valueFormat"]; shows: string }[] = [
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
        // The gutter holds exactly the labels the chart draws, so the browser sizes it for them.
        expect(gutterLabels(html)).toEqual(yAxisLayout(html, 342).labels.map((label) => label.text));
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

test("an extreme but valid value format keeps its tick labels whole and a plot that overflows instead of collapsing", () => {
  // The value format allows 20 decimal places and a 20-character unit: about 300px of label on a phone.
  const valueFormat = { style: "number", decimalPlaces: 20, unit: "kWh je Monat und Ort" } as const;
  for (const chartType of ["bar", "line"] as const) {
    const html = amounts([1_250_000, 3_400_000, 2_100_000], {
      chartType,
      valueFormat,
      yAxisLabel: "Verbrauch",
      dateConfig: { timeZone: "UTC", locale: "de" },
    });
    expect(gutterLabels(html)).toContain("1.000.000,00000000000000000000 kWh je Monat und Ort");
    const blockWidth = 342;
    const { yAxisLabelPx, labels, plotPx, chartEnd } = yAxisLayout(html, blockWidth);
    for (const label of labels) expect(label.left).toBeGreaterThanOrEqual(yAxisLabelPx);
    // A zero-width chart would lose its text: @k2b/ui can't keep it at pixel size there.
    expect(plotPx).toBeGreaterThanOrEqual(6 * REM_PX);
    expect(chartEnd).toBeGreaterThan(blockWidth);
  }
});

test("the tick gutter measures its labels in the font the chart draws them in", async () => {
  const html = amounts([3200.5, 14250], { valueFormat: { style: "number", decimalPlaces: 2, unit: "EUR" } });
  // stdlib's stylesheet inside the SVG sizes the tick labels, and @k2b/ui sets their font.
  const fontSize = html.match(/\.stdlib-chart-tick-label \{[^}]*font-size:\s*([^;}]+)/)?.[1]?.trim();
  const ui = await Bun.file(Bun.resolveSync("@k2b/ui/styles.css", import.meta.dir)).text();
  const fontFamily = ui.match(/\.k2b-chart \.stdlib-chart-tick-label[^{]*\{[^}]*font-family:\s*([^;}]+)/)?.[1]?.trim();
  expect(fontSize).toBeDefined();
  expect(fontFamily).toBeDefined();
  expect(html).toContain(`style="font-size:${fontSize};font-family:${fontFamily}" aria-hidden="true" data-chart-y-tick-gutter>`);
});
