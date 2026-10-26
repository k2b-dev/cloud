// Synchronous parts of `cloud.*` for scripts, actions and app frames: cloud.html,
// cloud.chart and cloud.money. No DOM needed.

import {
  type CloudAiChartInput,
  type CloudAiChartTable,
  type CloudAiFormat,
  type CloudAiNumberFormat,
  cloudAiAppChartSchema,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartTooltip,
} from "@k2b/cloud/ai/browser";
// Named renderers, not the `charts` namespace, so app frames leave out the map and state timeline renderers.
import {
  barGauge,
  boxplot,
  donut,
  escapeXml,
  gauge,
  heatmap,
  histogram,
  line,
  money,
  pie,
  scatter,
  sparkline,
  stat,
} from "@k2b/stdlib";
import { isChartDatum } from "@k2b/ui/chart-inspection";
import { barChartLayout, renderBarChartSvg } from "@k2b/ui/charts";
import { CloudError } from "./errors";
import { normalizeChartDates } from "./views";

/** Markup that `cloud.html` keeps as is. A String object, so string methods, innerHTML and `${}` all work. */
export class Html extends String {}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
const part = (value: unknown): string =>
  value instanceof Html
    ? String(value)
    : Array.isArray(value)
      ? value.map(part).join("")
      : value === null || value === undefined || value === false
        ? ""
        : escape(String(value));

/** Tagged template: escapes every interpolation, joins arrays, keeps nested cloud.html and cloud.chart markup. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1]!;
  return new Html(out);
}

const KEEP_ASPECT = new Set(["pie", "donut", "gauge"]);
type ChartOptions = Record<string, unknown> & {
  kind: string;
  format?: CloudAiNumberFormat | ((value: number) => string);
  xAxis?: Record<string, unknown> & { format?: CloudAiFormat | ((value: number) => string) };
  yAxis?: Record<string, unknown> & { format?: CloudAiFormat | ((value: number) => string) };
};
type StoredChart = {
  input: CloudAiChartInput;
  /** The author's logical height; bar rows take the height their labels need instead. */
  height?: number;
  title?: string;
  format?: (value: number) => string;
  xFormat?: (value: number) => string;
  yFormat?: (value: number) => string;
};
const ChartSchema = /* @__PURE__ */ cloudAiAppChartSchema();

function responsive(svg: string): string {
  return svg.replace("<svg ", '<svg preserveAspectRatio="none" ').replace(/<text\b[^>]*>/g, (tag) => {
    const x = tag.match(/\bx="(-?[\d.]+)"/)?.[1];
    const y = tag.match(/\by="(-?[\d.]+)"/)?.[1];
    if (x === undefined || y === undefined) return tag;
    const rotation = tag.match(/\btransform="rotate\((-?[\d.]+) [^"]+\)"/)?.[1];
    // The match ends at the tag's only ">"; insert the style before it.
    return `${tag.slice(0, -1)} style="transform-origin:${x}px ${y}px${rotation ? `;transform:rotate(${rotation}deg)` : ""}">`;
  });
}

/** SVG at the measured size; initial markup and redraws use the same mapping and function formats. */
export function chartSvg(options: StoredChart, locale: string, width: number, height: number): string {
  return drawChart(options, locale, width, height).svg;
}

function drawChart(options: StoredChart, locale: string, width: number, height: number): { svg: string; table: CloudAiChartTable } {
  try {
    const formats = { x: options.xFormat, y: options.yFormat, value: options.format };
    const mapped = cloudAiChartRenderOptions(options.input, locale, { width, formats });
    const common = { width, height, title: options.title, subtitle: options.input.subtitle, inspect: true };
    let svg: string;
    switch (mapped.kind) {
      case "bar": {
        // The title and subtitle take height too: lay out exactly what is drawn.
        const layout = barChartLayout({ ...mapped, ...common }, width);
        svg = renderBarChartSvg({ ...mapped, ...common, height: layout.layout === "rows" ? layout.height : (options.height ?? height) });
        break;
      }
      case "line":
        svg = line({ ...mapped, ...common });
        break;
      case "scatter":
        svg = scatter({ ...mapped, ...common });
        break;
      case "histogram":
        svg = histogram({ ...mapped, ...common });
        break;
      case "boxplot":
        svg = boxplot({ ...mapped, ...common });
        break;
      case "pie":
        svg = pie({ ...mapped, ...common });
        break;
      case "donut":
        svg = donut({ ...mapped, ...common });
        break;
      case "gauge":
        svg = gauge({ ...mapped, ...common });
        break;
      case "barGauge":
        svg = barGauge({ ...mapped, ...common });
        break;
      case "stat":
        svg = stat({ ...mapped, ...common, label: options.title ?? "" });
        break;
      case "heatmap":
        svg = heatmap({ ...mapped, ...common });
        break;
      case "sparkline":
        svg = sparkline({ ...mapped, ...common });
        break;
    }
    // Walk marks in emitted order, exactly as the chat builds its table and tooltips.
    const rows = cloudAiChartRows(options.input, locale, { formats });
    svg = svg.replace(
      /(<g data-chart-role="[^"]*" data-chart-datum="([^"]*)")><title>[\s\S]*?<\/title>/g,
      (match, opening: string, encoded: string) => {
        const datum: unknown = JSON.parse(
          encoded
            .replace(/&quot;/g, '"')
            .replace(/&apos;|&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&"),
        );
        // An empty stat may emit a null value; keep its static drawing, without inspecting it.
        if (!isChartDatum(datum)) return match;
        // App titles draw inside these kinds; only the contract's label is a data category, as in chat.
        if (datum.role === "value" && (mapped.kind === "stat" || mapped.kind === "gauge")) {
          datum.label = mapped.label;
          // A callback keeps "$&" or "$$" in a label literal.
          opening = opening.replace(/ data-chart-datum="[^"]*"/, () => ` data-chart-datum="${escapeXml(JSON.stringify(datum))}"`);
        }
        const row = rows.add(datum);
        const tooltip = cloudAiChartTooltip(rows.columns(), row);
        const text = [tooltip.title, ...tooltip.rows.map((row) => `${row.label}: ${row.value}`)].filter(Boolean).join(" · ");
        // Single-quoted XML attributes keep compact JSON quotes literal, saving space on dense charts.
        const encodedTooltip = escapeXml(JSON.stringify(tooltip)).replace(/&quot;/g, '"');
        return `${opening} data-chart-tooltip='${encodedTooltip}'><title>${escapeXml(text)}</title>`;
      },
    );
    // stdlib embeds an unlayered <style> with fixed colors; the base stylesheet owns those rules instead.
    svg = svg.replace(/<style>[\s\S]*?<\/style>/, "");
    return { svg: KEEP_ASPECT.has(mapped.kind) ? svg : responsive(svg), table: rows.table() };
  } catch (error) {
    throw new CloudError("invalid", `cloud.chart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Options of recent stretched charts by id, so an app frame can redraw them at their measured width (bounded). */
export const chartOptions = new Map<string, StoredChart>();
let chartSeq = 0;

/** The print value table is a sibling so image semantics and SVG redraws leave it intact. */
export function chart(options: ChartOptions, locale: string, timeZone = "UTC"): Html {
  const { width: logicalWidth, height: logicalHeight, ...raw } = options;
  const stored: Omit<StoredChart, "input"> = {};
  for (const name of ["xAxis", "yAxis"] as const) {
    const axis = raw[name];
    if (!axis || typeof axis !== "object" || Array.isArray(axis)) continue;
    const { format, ...rest } = axis;
    if (typeof format === "function") {
      if (name === "xAxis") stored.xFormat = format;
      else stored.yFormat = format;
      raw[name] = rest;
    }
  }
  if (typeof raw.format === "function") {
    stored.format = raw.format;
    delete raw.format;
  }
  const parsed = ChartSchema.safeParse(
    normalizeChartDates({ ...raw, title: raw.title ?? `${options.kind} chart` }, timeZone, "cloud.chart: ", true),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.path.reduce<string>(
      (text, part) => (typeof part === "number" ? `${text}[${part}]` : `${text}${text ? "." : ""}${String(part)}`),
      "",
    );
    throw new CloudError(
      "invalid",
      issue.path[0] === "kind"
        ? `cloud.chart: unknown kind "${String(options.kind)}"; use a supported chart kind.`
        : `cloud.chart: ${path ? `${path}: ` : ""}${issue.message}`,
    );
  }
  const input = parsed.data;
  // A sparkline is an inline word-sized graphic; other charts use the shared 480 × 280 drawing.
  const width = Number(logicalWidth) || (input.kind === "sparkline" ? 160 : 480);
  const height = Number(logicalHeight) || (input.kind === "sparkline" ? 40 : 280);
  const prepared = { input, ...stored, height, title: typeof options.title === "string" ? options.title : undefined };
  const { svg, table } = drawChart(prepared, locale, width, height);
  // Bar rows take the height their labels need; the box reserves it.
  const drawnHeight = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)?.[1]) || height;
  const stretch = !KEEP_ASPECT.has(input.kind);
  const title = typeof options.title === "string" ? options.title : "";
  const subtitle = typeof options.subtitle === "string" ? options.subtitle : "";
  const caption = [title, subtitle].filter(Boolean).join(" — ") || `${input.kind} chart`;
  const label = ` role="img" aria-label="${escape(caption)}"`;
  const values = table.rows.length
    ? `<table class="k2b-chart__table" hidden><caption>${escape(caption)}</caption><thead><tr>${table.columns
        .map((col) => `<th scope="col"${col.numeric ? ' class="num"' : ""}>${escape(col.label)}</th>`)
        .join("")}</tr></thead><tbody>${table.rows
        .map(
          (row) =>
            `<tr>${table.columns.map((col) => `<td${col.numeric ? ' class="num"' : ""}>${escape(row.cells[col.id] ?? "")}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody></table>`
    : "";
  let id = "";
  if (stretch && !logicalWidth) {
    id = `c${++chartSeq}`;
    chartOptions.set(id, prepared);
    if (chartOptions.size > 200) chartOptions.delete(chartOptions.keys().next().value!);
  }
  return new Html(
    `<div class="k2b-chart" data-chart-kind="${input.kind}"${label}><div class="k2b-chart__svg"${stretch ? " data-stretch" : ""}${id ? ` data-chart-id="${id}"` : ""} style="--k2b-chart-width:${width}px;--k2b-chart-height:${drawnHeight}px">${svg}</div></div>${values}`,
  );
}

/** stdlib money with the user's locale as the default for format and parse. */
export function boundMoney(locale: string) {
  return {
    ...money,
    format: (value: Parameters<typeof money.format>[0], options?: { locale?: string }) =>
      money.format(value, { locale: options?.locale ?? locale }),
    parse: (text: string, options: { currency: string; locale?: string; rounding?: "half-up" | "half-even" | "toward-zero" }) =>
      money.parse(
        text
          .trim()
          .replace(options.currency, "")
          .replace(
            new Intl.NumberFormat(options.locale ?? locale, { style: "currency", currency: options.currency })
              .formatToParts(0)
              .find((p) => p.type === "currency")?.value ?? options.currency,
            "",
          )
          .trim(),
        { ...options, locale: options.locale ?? locale },
      ),
  };
}
