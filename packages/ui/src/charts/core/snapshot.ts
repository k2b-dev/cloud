import { calendarLayout } from "./calendar";
import { type ChartSelection, type ChartTooltip, type ChartTooltipFormatter, isChartDatum } from "./inspection";
import { type ChartRenderOptions, chartRenderHeight, renderChartSvg } from "./render";
import { sankeyWidth } from "./sankey-size";
import { escapeXml } from "./svg-renderers";
import type { ChartDatum, ChartKind } from "./types";

/** Trusted output of prepareChartSnapshot; never accept arbitrary user SVG. */
export type ChartSnapshot = {
  kind: ChartKind;
  svg: string;
  width: number;
  height: number;
  stretch: boolean;
  minWidth?: number;
  /** Uniform calendar growth stops at 32px cells. */
  maxWidth?: number;
  marks: readonly { key: string; rowKey: string; datum: ChartDatum; tooltip: ChartTooltip; reference?: boolean }[];
};

// Matches metadata emitted by our SVG renderer, not arbitrary XML.
const decodeAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Pure SVG preparation for server or browser. Transfer only this output across SSR boundaries. */
export function prepareChartSnapshot(
  options: ChartRenderOptions,
  inspection: {
    key: (selection: ChartSelection) => string;
    /** Defaults to the mark key for one-to-one charts. */
    rowKey?: (selection: ChartSelection) => string;
    tooltip: ChartTooltipFormatter;
    reference?: (selection: ChartSelection) => boolean;
  },
  sizing: Parameters<typeof chartRenderHeight>[1] = {},
): ChartSnapshot {
  const calendar = options.kind === "heatmap" && options.layout === "calendar" ? calendarLayout(options) : undefined;
  const width = options.kind === "sankey" ? sankeyWidth(options, options.displayWidth ?? 480) : (calendar?.width ?? 480);
  const height = chartRenderHeight(options, sizing);
  const svg = renderChartSvg(options, width, height);
  const marks: ChartSnapshot["marks"][number][] = [];
  const keys = new Set<string>();
  for (const match of svg.matchAll(/data-chart-datum="([^"]*)"/g)) {
    const datum: unknown = JSON.parse(decodeAttribute(match[1]!));
    if (!isChartDatum(datum)) throw new Error("Invalid renderer chart metadata");
    const selection = { kind: options.kind, datum };
    const key = inspection.key(selection);
    if (!key || keys.has(key)) throw new Error("Chart snapshot requires a unique nonempty key for every mark");
    keys.add(key);
    const rowKey = inspection.rowKey?.(selection) ?? key;
    if (!rowKey) throw new Error("Chart marks require a nonempty rowKey");
    marks.push({
      key,
      rowKey,
      datum,
      tooltip: inspection.tooltip(selection),
      ...(inspection.reference?.(selection) ? { reference: true } : {}),
    });
  }
  let markIndex = 0;
  const formattedSvg = svg.replace(
    /(<g data-chart-role="[^"]*" data-chart-datum="[^"]*"><title>)[\s\S]*?<\/title>/g,
    (_match, opening: string, offset: number) => {
      const mark = marks[markIndex++]!;
      const tooltip = mark.tooltip;
      const text = [tooltip.title, ...tooltip.rows.map((row) => `${row.label}: ${row.value}`)].filter(Boolean).join(" · ");
      if (mark.reference) {
        const children = svg.slice(offset, svg.indexOf("</g>", offset));
        const palette = (Number(children.match(/stdlib-chart-series-(\d+)/)?.[1] ?? mark.datum.seriesIndex ?? 0) % 8) + 1;
        opening = opening.replace(
          "<g ",
          `<g data-chart-reference="true" style="--k2b-chart-reference-color:var(--stdlib-chart-c${palette})" `,
        );
      }
      return `${opening}${escapeXml(text)}</title>`;
    },
  );
  return {
    kind: options.kind,
    svg: formattedSvg,
    width,
    height,
    ...(calendar ? { minWidth: calendar.minWidth, maxWidth: calendar.maxWidth } : {}),
    stretch: !calendar && !["map", "pie", "donut", "gauge", "radar"].includes(options.kind),
    marks,
  };
}
