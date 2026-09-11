import { escapeXml, type ChartDatum } from "@k2b/stdlib";
import { renderChartSvg, type ChartKind, type ChartProps } from "./Chart";
import { isChartDatum, type ChartSelection, type ChartTooltip, type ChartTooltipFormatter } from "./chart-inspection";
import { stateTimelineHeight } from "./chart-state-timeline";

/** Trusted output of prepareChartSnapshot; never accept arbitrary user SVG. */
export type ChartSnapshot = {
  kind: ChartKind;
  svg: string;
  width: number;
  height: number;
  stretch: boolean;
  marks: readonly { key: string; datum: ChartDatum; tooltip: ChartTooltip }[];
};

// Matches metadata emitted by our SVG renderer, not arbitrary XML.
const decodeAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Call on the server. Functions run here; only SVG, keys and text cross the wire. */
export function prepareChartSnapshot(
  options: ChartProps,
  inspection: { key: (selection: ChartSelection) => string; tooltip: ChartTooltipFormatter },
): ChartSnapshot {
  const width = 480;
  const height = options.kind === "stateTimeline" ? stateTimelineHeight(options.rows.length, options.legend !== false) : 280;
  const svg = renderChartSvg({ ...options, interactive: true }, width, height);
  const marks: ChartSnapshot["marks"][number][] = [];
  const keys = new Set<string>();
  for (const match of svg.matchAll(/data-chart-datum="([^"]*)"/g)) {
    const datum: unknown = JSON.parse(decodeAttribute(match[1]!));
    if (!isChartDatum(datum)) throw new Error("Invalid renderer chart metadata");
    const selection = { kind: options.kind, datum };
    const key = inspection.key(selection);
    if (!key || keys.has(key)) throw new Error("Chart snapshot requires a unique nonempty key for every mark");
    keys.add(key);
    marks.push({ key, datum, tooltip: inspection.tooltip(selection) });
  }
  let markIndex = 0;
  const formattedSvg = svg.replace(
    /(<g data-chart-role="[^"]*" data-chart-datum="[^"]*"><title>)[\s\S]*?<\/title>/g,
    (_match, opening: string) => {
      const tooltip = marks[markIndex++]!.tooltip;
      const text = [tooltip.title, ...tooltip.rows.map((row) => `${row.label}: ${row.value}`)].filter(Boolean).join(" · ");
      return `${opening}${escapeXml(text)}</title>`;
    },
  );
  return { kind: options.kind, svg: formattedSvg, width, height, stretch: !["map", "pie", "donut", "gauge"].includes(options.kind), marks };
}
