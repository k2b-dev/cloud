// Synchronous parts of `cloud.*` for scripts, actions and app frames: cloud.html,
// cloud.chart and cloud.money. No DOM needed.

import {
  type CloudAiChartInput,
  type CloudAiFormat,
  type CloudAiNumberFormat,
  chartDrawingIssue,
  cloudAiChartRenderOptions,
  cloudAiChartSchema,
} from "@k2b/cloud/ai/browser";
import { charts, money } from "@k2b/stdlib";
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
  title?: string;
  format?: (value: number) => string;
  xFormat?: (value: number) => string;
  yFormat?: (value: number) => string;
};
const ChartSchema = /* @__PURE__ */ cloudAiChartSchema();

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
  const mapped = cloudAiChartRenderOptions(options.input, locale, { width });
  const common = { width, height, title: options.title, subtitle: options.input.subtitle };
  const value = { ...(options.format ? { format: options.format } : {}) };
  const yAxis = (axis: Parameters<typeof charts.bar>[0]["yAxis"]) => ({ ...axis, ...(options.yFormat ? { format: options.yFormat } : {}) });
  const xAxis = (axis: Parameters<typeof charts.line>[0]["xAxis"]) => ({
    ...axis,
    ...(options.xFormat ? { format: options.xFormat } : {}),
  });
  let svg: string;
  switch (mapped.kind) {
    case "bar":
      svg = charts.bar({ ...mapped, ...common, yAxis: yAxis(mapped.yAxis) });
      break;
    case "line":
      svg = charts.line({ ...mapped, ...common, xAxis: xAxis(mapped.xAxis), yAxis: yAxis(mapped.yAxis) });
      break;
    case "scatter":
      svg = charts.scatter({ ...mapped, ...common, xAxis: xAxis(mapped.xAxis), yAxis: yAxis(mapped.yAxis) });
      break;
    case "histogram":
      svg = charts.histogram({ ...mapped, ...common, xAxis: xAxis(mapped.xAxis), yAxis: yAxis(mapped.yAxis) });
      break;
    case "boxplot":
      svg = charts.boxplot({ ...mapped, ...common, yAxis: yAxis(mapped.yAxis) });
      break;
    case "pie":
      svg = charts.pie({ ...mapped, ...common, ...value });
      break;
    case "donut":
      svg = charts.donut({ ...mapped, ...common, ...value });
      break;
    case "gauge":
      svg = charts.gauge({ ...mapped, ...common, ...value });
      break;
    case "barGauge":
      svg = charts.barGauge({ ...mapped, ...common, ...value });
      break;
    case "stat":
      svg = charts.stat({ ...mapped, ...common, ...value, ...(options.format ? { deltaFormat: options.format } : {}) });
      break;
    case "heatmap":
      svg = charts.heatmap({ ...mapped, ...common, ...value });
      break;
    case "sparkline":
      svg = charts.sparkline({ ...mapped, ...common });
      break;
  }
  // stdlib embeds an unlayered <style> with fixed colors; the base stylesheet owns those rules instead.
  svg = svg.replace(/<style>[\s\S]*?<\/style>/, "");
  return KEEP_ASPECT.has(mapped.kind) ? svg : responsive(svg);
}

/** Options of recent stretched charts by id, so an app frame can redraw them at their measured width (bounded). */
export const chartOptions = new Map<string, StoredChart>();
let chartSeq = 0;

/** Markup of the shared Chart component, with the same contract as declarative charts. */
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
  const issue = chartDrawingIssue(parsed.data);
  if (issue) throw new CloudError("invalid", `cloud.chart: ${issue}`);
  const input = parsed.data;
  // A sparkline is an inline word-sized graphic; other charts use the shared 480 × 280 drawing.
  const width = Number(logicalWidth) || (input.kind === "sparkline" ? 160 : 480);
  const height = Number(logicalHeight) || (input.kind === "sparkline" ? 40 : 280);
  const prepared = { input, ...stored, title: typeof options.title === "string" ? options.title : undefined };
  const svg = chartSvg(prepared, locale, width, height);
  const stretch = !KEEP_ASPECT.has(input.kind);
  const title = typeof options.title === "string" ? options.title : "";
  const subtitle = typeof options.subtitle === "string" ? options.subtitle : "";
  const label = ` role="img" aria-label="${escape([title, subtitle].filter(Boolean).join(" — ") || `${input.kind} chart`)}"`;
  let id = "";
  if (stretch && !logicalWidth) {
    id = `c${++chartSeq}`;
    chartOptions.set(id, prepared);
    if (chartOptions.size > 200) chartOptions.delete(chartOptions.keys().next().value!);
  }
  return new Html(
    `<div class="k2b-chart" data-chart-kind="${input.kind}"${label}><div class="k2b-chart__svg"${stretch ? " data-stretch" : ""}${id ? ` data-chart-id="${id}"` : ""} style="--k2b-chart-width:${width}px;--k2b-chart-height:${height}px">${svg}</div></div>`,
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
