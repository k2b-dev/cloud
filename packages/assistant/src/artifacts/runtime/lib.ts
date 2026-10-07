// Synchronous helpers for the isolated script/action worker. No DOM needed.

import { bar, donut, gauge, histogram, line, money, pie, scatter, sparkline } from "@k2b/stdlib";
import { CloudError } from "./errors";

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

const RENDERERS = { bar, line, pie, donut, scatter, sparkline, gauge, histogram } as const;
type Kind = keyof typeof RENDERERS;
// Logical drawing size; the stylesheet stretches cartesian charts to the container width
// and keeps text and markers at pixel size (same mechanism as @k2b/ui Chart).
const SIZE: Record<Kind, [number, number]> = {
  bar: [640, 280],
  line: [640, 280],
  scatter: [640, 280],
  histogram: [640, 280],
  sparkline: [160, 40],
  pie: [320, 240],
  donut: [320, 240],
  gauge: [260, 180],
};
const KEEP_ASPECT = new Set<Kind>(["pie", "donut", "gauge"]);

type AnyOptions = Record<string, unknown> & { kind: string };

function responsive(svg: string): string {
  return svg.replace("<svg ", '<svg preserveAspectRatio="none" ').replace(/<text\b[^>]*>/g, (tag) => {
    const x = tag.match(/\bx="(-?[\d.]+)"/)?.[1];
    const y = tag.match(/\by="(-?[\d.]+)"/)?.[1];
    if (x === undefined || y === undefined) return tag;
    const rotation = tag.match(/\btransform="rotate\((-?[\d.]+) [^"]+\)"/)?.[1];
    return tag.replace(">", ` style="transform-origin:${x}px ${y}px${rotation ? `;transform:rotate(${rotation}deg)` : ""}">`);
  });
}

/** Points may carry Date or ISO strings as x; they become timestamps with a locale date axis. */
function withDates(options: AnyOptions, locale: string): AnyOptions {
  if (options.kind !== "line" && options.kind !== "scatter") return options;
  const series = options.series as { data: { x: unknown }[] }[] | undefined;
  if (!Array.isArray(series)) return options;
  const isDate = (x: unknown) => x instanceof Date || (typeof x === "string" && !Number.isNaN(Date.parse(x)));
  if (!series.some((s) => s.data?.some((p) => isDate(p.x)))) return options;
  const time = (x: unknown) => (x instanceof Date ? x.getTime() : typeof x === "string" ? Date.parse(x) : Number(x));
  const day = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" });
  const xAxis = (options.xAxis ?? {}) as Record<string, unknown>;
  return {
    ...options,
    series: series.map((s) => ({ ...s, data: s.data.map((p) => ({ ...p, x: time(p.x) })) })),
    xAxis: { format: (v: number) => day.format(v), ...xAxis },
  };
}

/** Number axes default to the user's number format. */
function withNumbers(options: AnyOptions, locale: string): AnyOptions {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const axis = (key: "xAxis" | "yAxis") => {
    const current = (options[key] ?? {}) as Record<string, unknown>;
    return { format: (v: number) => number.format(v), ...current };
  };
  if (options.kind === "bar" || options.kind === "histogram") return { ...options, yAxis: axis("yAxis") };
  if (options.kind === "line" || options.kind === "scatter") return { ...options, xAxis: axis("xAxis"), yAxis: axis("yAxis") };
  return options;
}

// Tick labels are 11px IBM Plex Mono: about 6.7px per character.
const CHAR = 6.7;

/** stdlib reserves a fixed 40px for y tick labels and never shortens category labels; fit both to the real size. */
function fitted(options: AnyOptions, width: number): AnyOptions {
  if (options.padding !== undefined) return options;
  const yAxis = options.yAxis as { format?: (v: number) => string } | undefined;
  const values =
    options.kind === "bar"
      ? [0, ...((options.data as { value: number }[]) ?? []).map((d) => d.value)]
      : options.kind === "line" || options.kind === "scatter"
        ? ((options.series as { data: { y: number }[] }[]) ?? []).flatMap((s) => s.data.map((p) => p.y))
        : [];
  if (!values.length || !yAxis?.format) return options;
  const finite = values.filter(Number.isFinite);
  const extremes = [Math.min(...finite), Math.max(...finite)];
  // Nice ticks can exceed the data a little; one extra digit of room covers that.
  const longest = Math.max(...extremes.map((v) => yAxis.format!(v).length)) + 1;
  const left = Math.max(40, Math.ceil(longest * CHAR) + 10);
  let next: AnyOptions = { ...options, padding: { top: 16, right: 16, bottom: 32, left } };
  if (options.kind === "bar") {
    const data = options.data as { label: string; value: number }[];
    const longestLabel = Math.max(1, ...data.map((d) => d.label.length));
    const step = Math.max(1, Math.ceil(((longestLabel + 1) * CHAR * data.length) / Math.max(width - left - 16, 1)));
    next = { ...next, data: data.map((d, i) => ({ ...d, label: i % step === 0 ? d.label : "" })) };
  }
  return next;
}

/** SVG for `options` at a logical size; used for the first markup and for redraws at the measured width. */
export function chartSvg(options: AnyOptions, locale: string, width: number, height: number): string {
  const kind = options.kind as Kind;
  const prepared = fitted(withNumbers(withDates(options, locale), locale), width);
  // stdlib embeds an unlayered <style> with fixed colors; the base stylesheet owns those rules instead.
  const svg = (RENDERERS[kind] as (o: object) => string)({ ...prepared, width, height }).replace(/<style>[\s\S]*?<\/style>/, "");
  return KEEP_ASPECT.has(kind) ? svg : responsive(svg);
}

export function chart(options: AnyOptions, locale: string): Html {
  const kind = options?.kind as Kind;
  const render = RENDERERS[kind] as ((o: object) => string) | undefined;
  if (!render)
    throw new CloudError(
      "invalid",
      `cloud.chart: unknown kind "${String(options?.kind)}"; use one of ${Object.keys(RENDERERS).join(", ")}.`,
    );
  const [width, height] = [Number(options.width) || SIZE[kind][0], Number(options.height) || SIZE[kind][1]];
  const svg = chartSvg(options, locale, width, height);
  const stretch = !KEEP_ASPECT.has(kind);
  const title = typeof options.title === "string" ? options.title : "";
  const subtitle = typeof options.subtitle === "string" ? options.subtitle : "";
  const label = ` role="img" aria-label="${escape([title, subtitle].filter(Boolean).join(" — ") || `${kind} chart`)}"`;
  return new Html(
    `<div class="cloud-chart" data-chart-kind="${kind}"${stretch ? " data-stretch" : ""}${label} style="--k2b-chart-width:${width}px;--k2b-chart-height:${height}px${stretch ? "" : `;aspect-ratio:${width}/${height}`}">${svg}</div>`,
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
