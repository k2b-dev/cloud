import { CloudAiViewSummarySchema } from "@k2b/cloud/ai/app-frame";
import { computeDomain, niceStep } from "@k2b/stdlib";
import { z } from "zod";
import type { RuntimeContext } from "./cloud";
import { CloudError } from "./errors";

const viewRefSchema = () =>
  z.intersection(CloudAiViewSummarySchema, z.object({ path: z.string().startsWith("/views/").endsWith(".view.json") }));
export const ViewRefSchema = /* @__PURE__ */ viewRefSchema();
export type ViewRef = z.output<typeof ViewRefSchema>;

type Row = Record<string, unknown>;
// Column names may match Object.prototype; only the row's own cells are data.
const cellOf = (row: Row, id: string): unknown => (Object.hasOwn(row, id) ? row[id] : undefined);
const invalid = (path: string, message: string): never => {
  throw new CloudError("invalid", `${path}: ${message}`);
};
const object = (value: unknown, path: string): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) return invalid(path, "Expected an object.");
  return Object.fromEntries(Object.entries(value));
};
const reference = (value: unknown, path: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) return undefined;
  const ref = object(value, path);
  if (!Object.hasOwn(ref, "type") || !Object.hasOwn(ref, "id") || typeof ref.type !== "string" || typeof ref.id !== "string")
    return undefined;
  // Capability results may carry an empty title; the host then shows the id.
  const title = Object.hasOwn(ref, "title") && typeof ref.title === "string" && ref.title.trim() ? ref.title : undefined;
  return { type: ref.type, id: ref.id, ...(title ? { title } : {}) };
};
const rowsOf = (value: unknown, path = "rows"): Row[] => {
  if (!Array.isArray(value)) return invalid(path, "Expected an array of objects.");
  return value.map((row, index) => object(row, `${path}[${index}]`));
};
const columnId = (value: unknown, path: string): string =>
  typeof value === "string" && value ? value : invalid(path, "Expected a column name.");
const number = (value: unknown, path: string): number =>
  typeof value === "number" && Number.isFinite(value) ? value : invalid(path, "Expected a finite number; convert it to text or a number.");
const wallClock = (value: Date, timeZone: string, path: string): string => {
  if (!Number.isFinite(value.getTime())) return invalid(path, "Expected a valid Date.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
};

const MIDNIGHT = /T00:00(?::00)?$/;

/** Dates become wall-clock chart strings; apps also accept ISO instants with an offset. */
export function normalizeChartDates(spec: Row, timeZone: string, prefix = "", instants = false): Row {
  const instantDate = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/;
  const date = (value: unknown, path: string) => {
    if (value instanceof Date) return wallClock(value, timeZone, path);
    if (instants && typeof value === "string") {
      const instant = instantDate.exec(value);
      if (instant) {
        const offset = instant[3]!;
        const normalized = offset === "Z" ? offset : offset.length === 3 ? `${offset}:00` : offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
        return wallClock(new Date(`${instant[1]}T${instant[2]}${normalized}`), timeZone, path);
      }
      const written = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?)?)?)?$/.exec(value);
      if (written)
        return `${written[1]}-${written[2] ?? "01"}-${written[3] ?? "01"}${written[4] ? `T${written[4]}${written[5] ? `:${written[5]}` : ""}` : ""}`;
    }
    return value;
  };
  const record = (value: unknown): Row | undefined =>
    value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  let midnight = true;
  const converted = new WeakSet<object>();
  const series =
    (spec.kind === "line" || spec.kind === "scatter") && Array.isArray(spec.series)
      ? spec.series.map((raw, i) => {
          const entry = record(raw);
          if (!entry || !Array.isArray(entry.data)) return raw;
          return {
            ...entry,
            data: entry.data.map((raw, j) => {
              const point = record(raw);
              if (!point) return raw;
              const x = date(point.x, `${prefix}series[${i}].data[${j}].x`);
              const normalized = { ...point, x };
              // Apps show calendar days when every date is at midnight, as their date axes always did; views keep
              // what the run wrote and only shorten the Dates they converted.
              if (instants ? typeof x === "string" : x !== point.x) {
                converted.add(normalized);
                if (typeof x === "string" && x.length > 10 && !MIDNIGHT.test(x)) midnight = false;
              }
              return normalized;
            }),
          };
        })
      : undefined;
  const day = (x: unknown) => (midnight && typeof x === "string" && MIDNIGHT.test(x) ? x.slice(0, 10) : x);
  return {
    ...spec,
    ...(series
      ? {
          series: series.map((raw) => {
            const entry = record(raw);
            return entry && Array.isArray(entry.data)
              ? {
                  ...entry,
                  data: entry.data.map((raw) => {
                    const point = record(raw);
                    return point && typeof raw === "object" && raw !== null && converted.has(raw) ? { ...point, x: day(point.x) } : raw;
                  }),
                }
              : raw;
          }),
        }
      : {}),
    ...(Array.isArray(spec.references)
      ? {
          references: spec.references.map((raw, index) => {
            const ref = record(raw);
            return ref ? { ...ref, value: date(ref.value, `${prefix}references[${index}].value`) } : raw;
          }),
        }
      : {}),
  };
}

const labelText = (value: unknown, timeZone: string, path: string): string => {
  if (value instanceof Date) {
    const time = wallClock(value, timeZone, path);
    return time.endsWith("T00:00:00") ? time.slice(0, 10) : time;
  }
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return String(value);
  return invalid(path, "Expected a label: text, a number or a Date.");
};

function histogram(values: number[], bins: unknown, locale: string, prefix = "") {
  if (!values.length) return invalid(`${prefix}rows`, "A histogram needs at least one number.");
  let min = Infinity,
    max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const format = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 });
  let edges: number[];
  if (Array.isArray(bins)) {
    edges = bins.map((value, index) => number(value, `${prefix}bins[${index}]`));
    if (edges.length < 2 || edges.length > 481 || edges.some((edge, index) => index > 0 && edge <= edges[index - 1]!))
      return invalid(`${prefix}bins`, "Use 2..481 ascending finite edges.");
    if (edges[0]! > min || edges[edges.length - 1]! < max) return invalid(`${prefix}bins`, "Edges must cover every observation.");
  } else {
    const count = bins === undefined ? Math.min(480, Math.ceil(Math.log2(values.length)) + 1) : number(bins, `${prefix}bins`);
    if (!Number.isInteger(count) || count < 1 || count > 480) return invalid(`${prefix}bins`, "Use a bin count from 1 to 480.");
    if (min === max) return [{ label: format.format(min), value: values.length }];
    const domain = computeDomain([min, max]);
    let step = niceStep(domain[1] - domain[0], count);
    if (!Number.isFinite(step) || step <= 0 || min + step === min)
      return invalid(`${prefix}bins`, "Values cannot form finite bin edges; subtract a common offset first.");
    // Edges are whole multiples of the step. A quotient such as 0.3 / 0.1 = 2.9999999999999996 is rounded before it
    // picks an edge, so a value on an edge starts the next bin as documented.
    const index = (value: number) => Number((value / step).toPrecision(15));
    let first = Math.floor(index(min));
    let size = Math.max(1, Math.ceil(index(max)) - first);
    // Rounding the step down may exceed the chart's mark budget.
    if (size > 480) {
      step = niceStep(domain[1] - domain[0], count / 2);
      first = Math.floor(index(min));
      size = Math.max(1, Math.ceil(index(max)) - first);
    }
    if (size > 480 || !Number.isFinite(size)) return invalid(`${prefix}bins`, "At most 480 bins are allowed.");
    // Each edge keeps the step's decimal places, so 3 × 0.1 is 0.3 like the value in the data.
    const [digits, exponent = "0"] = Number(step.toPrecision(15)).toString().split("e");
    const decimals = Math.max(0, (digits!.split(".")[1]?.length ?? 0) - Number(exponent));
    edges = Array.from({ length: size + 1 }, (_, offset) => {
      const edge = (first + offset) * step;
      // toFixed supports at most 100 fraction digits.
      return Number(decimals <= 100 ? edge.toFixed(decimals) : edge.toPrecision(15));
    });
    if (edges[edges.length - 1]! < max) edges[edges.length - 1] = max;
  }
  if (min === max) return [{ label: format.format(min), value: values.length }];
  const counts = Array.from({ length: edges.length - 1 }, () => 0);
  for (const value of values) {
    let low = 0,
      high = edges.length - 2;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (value >= edges[mid]!) low = mid;
      else high = mid - 1;
    }
    counts[low] = counts[low]! + 1;
  }
  return counts.map((value, index) => ({ label: `${format.format(edges[index]!)}–${format.format(edges[index + 1]!)}`, value }));
}

/** Converts script rows to plain data; only the server decides whether the resulting view is valid. */
export function createViews(
  rpc: (method: string, args: unknown[]) => Promise<unknown>,
  context: Pick<RuntimeContext, "locale" | "timeZone">,
  script = false,
) {
  const save = async (view: unknown): Promise<ViewRef> => ViewRefSchema.parse(await rpc("view.save", [view]));
  const available = () => {
    if (!script) throw new CloudError("unavailable", "cloud.view.* works in code_run scripts; an app draws charts with cloud.chart().");
  };
  const convertRows = (raw: unknown, prefix = ""): Row => {
    const spec = object(raw, prefix ? prefix.slice(0, -1) : "chart");
    if (spec.rows === undefined) return spec;
    const { rows: input, x, y, value, bins, series, ...options } = spec;
    const rows = rowsOf(input, `${prefix}rows`);
    const values = (id: string) =>
      rows.flatMap((row, index) => (cellOf(row, id) == null ? [] : [number(cellOf(row, id), `${prefix}rows[${index}].${id}`)]));
    if (spec.kind === "gauge" || spec.kind === "stat") return invalid(`${prefix}rows`, `A ${spec.kind} takes a value, not rows.`);
    if (spec.kind === "histogram")
      return { ...options, kind: "bar", data: histogram(values(columnId(value, `${prefix}value`)), bins, context.locale, prefix) };
    if (spec.kind === "heatmap") {
      const xId = columnId(x, `${prefix}x`),
        yId = columnId(y, `${prefix}y`),
        valueId = columnId(value, `${prefix}value`);
      return {
        ...options,
        data: rows.flatMap((row, index) =>
          cellOf(row, valueId) == null
            ? []
            : [
                {
                  x: labelText(cellOf(row, xId), context.timeZone, `${prefix}rows[${index}].${xId}`),
                  y: labelText(cellOf(row, yId), context.timeZone, `${prefix}rows[${index}].${yId}`),
                  value: number(cellOf(row, valueId), `${prefix}rows[${index}].${valueId}`),
                },
              ],
        ),
      };
    }
    const ys = Array.isArray(y) ? y.map((id, index) => columnId(id, `${prefix}y[${index}]`)) : [columnId(y, `${prefix}y`)];
    if (spec.kind === "sparkline") {
      if (ys.length !== 1) return invalid(`${prefix}y`, "Choose one value column.");
      return { ...options, data: values(ys[0]!) };
    }
    const label = columnId(x, `${prefix}x`);
    if (spec.kind === "boxplot") {
      if (ys.length !== 1) return invalid(`${prefix}y`, "Choose one value column.");
      const grouped = new Map<string, number[]>();
      rows.forEach((row, index) => {
        if (cellOf(row, ys[0]!) == null) return;
        const name = labelText(cellOf(row, label), context.timeZone, `${prefix}rows[${index}].${label}`);
        const values = grouped.get(name) ?? [];
        values.push(number(cellOf(row, ys[0]!), `${prefix}rows[${index}].${ys[0]}`));
        grouped.set(name, values);
      });
      return { ...options, data: [...grouped].map(([label, values]) => ({ label, values })) };
    }
    if (spec.kind === "bar" || spec.kind === "pie" || spec.kind === "donut" || spec.kind === "barGauge") {
      if (ys.length !== 1) return invalid(`${prefix}y`, "Choose one value column.");
      return {
        ...options,
        data: rows.flatMap((row, index) =>
          cellOf(row, ys[0]!) == null
            ? []
            : [
                {
                  label: labelText(cellOf(row, label), context.timeZone, `${prefix}rows[${index}].${label}`),
                  value: number(cellOf(row, ys[0]!), `${prefix}rows[${index}].${ys[0]}`),
                },
              ],
        ),
      };
    }
    if (spec.kind !== "line" && spec.kind !== "scatter") return invalid(`${prefix}kind`, "Unknown chart kind.");
    if (series !== undefined && ys.length !== 1) return invalid(`${prefix}series`, "Long format needs one y column.");
    const group = series === undefined ? undefined : columnId(series, `${prefix}series`);
    const grouped = new Map<unknown, { label: string; data: { x: string | number | Date; y: number }[] }>();
    for (const [index, row] of rows.entries())
      for (const id of ys) {
        if (cellOf(row, id) == null) continue;
        const groupCell = group ? cellOf(row, group) : id;
        const groupLabel = labelText(groupCell, context.timeZone, `${prefix}rows[${index}].${group ?? id}`);
        const key = groupCell instanceof Date ? groupLabel : groupCell;
        let entry = grouped.get(key);
        if (!entry) {
          entry = { label: groupLabel, data: [] };
          grouped.set(key, entry);
        }
        const cell = cellOf(row, label);
        if (cell instanceof Date && !Number.isFinite(cell.getTime()))
          return invalid(`${prefix}rows[${index}].${label}`, "Expected a valid Date.");
        const pointX = cell instanceof Date ? cell : typeof cell === "string" ? cell : number(cell, `${prefix}rows[${index}].${label}`);
        entry.data.push({ x: pointX, y: number(cellOf(row, id), `${prefix}rows[${index}].${id}`) });
      }
    return { ...options, series: [...grouped.values()] };
  };
  // The server validates the result; converting only names the script's own rows and dates.
  const convertChart = (raw: unknown, prefix = "") => {
    const { view: _view, ...chart } = normalizeChartDates(convertRows(raw, prefix), context.timeZone, prefix);
    return chart;
  };
  const convertDataset = (raw: unknown, kind: "table" | "explorer") => {
    const spec = object(raw, kind);
    const rows = rowsOf(spec.rows);
    const footer = kind !== "table" || spec.footer === undefined ? undefined : object(spec.footer, "footer");
    const inputColumns = spec.columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (!Array.isArray(inputColumns)) return invalid("columns", "Expected column names or objects.");
    const columns = inputColumns.map((raw, index) => {
      const column = typeof raw === "string" ? { id: raw } : object(raw, `columns[${index}]`);
      const id = columnId(column.id, `columns[${index}].id`);
      const cells = [...rows.map((row) => cellOf(row, id)), ...(footer ? [cellOf(footer, id)] : [])].filter((cell) => cell != null);
      const type =
        column.type ??
        (!cells.length
          ? "text"
          : cells.every((cell) => typeof cell === "number")
            ? "number"
            : cells.every((cell) => cell instanceof Date)
              ? "datetime"
              : cells.every((cell) => reference(cell, `columns[${index}].${id}`) !== undefined)
                ? "ref"
                : "text");
      return { ...column, id, type };
    });
    const normalize = (row: Row, path: string) =>
      Object.fromEntries(
        columns.map(({ id, type }) => {
          const cell = cellOf(row, id);
          if (cell == null) return [id, null];
          // A date column keeps the calendar day of the run's time zone.
          if (cell instanceof Date) {
            const time = wallClock(cell, context.timeZone, `${path}.${id}`);
            return [id, type === "date" ? time.slice(0, 10) : time];
          }
          if (typeof cell === "string" || (typeof cell === "number" && Number.isFinite(cell))) return [id, cell];
          const ref = reference(cell, `${path}.${id}`);
          if (ref) return [id, ref];
          return invalid(`${path}.${id}`, "Unsupported cell; convert it to text or a number, or use a Cloud reference {type, id, title?}.");
        }),
      );
    return {
      ...spec,
      view: kind,
      columns,
      rows: rows.map((row, index) => normalize(row, `rows[${index}]`)),
      ...(footer ? { footer: normalize(footer, "footer") } : {}),
    };
  };
  return {
    async chart(raw: unknown): Promise<ViewRef> {
      available();
      return save({ ...convertChart(raw), view: "chart" });
    },
    async group(raw: unknown): Promise<ViewRef> {
      available();
      const spec = object(raw, "group");
      if (!Array.isArray(spec.charts)) return invalid("charts", "Expected an array of charts.");
      return save({ ...spec, view: "group", charts: spec.charts.map((chart, index) => convertChart(chart, `charts[${index}].`)) });
    },
    async stats(raw: unknown): Promise<ViewRef> {
      available();
      const spec = object(raw, "stats");
      const items = rowsOf(spec.items, "items");
      items.forEach((item, index) => {
        if (item.value instanceof Date)
          invalid(`items[${index}].value`, "A stats value cannot be a Date; format it as text or use cloud.view.details.");
      });
      return save({ ...spec, view: "stats", items });
    },
    async details(raw: unknown): Promise<ViewRef> {
      available();
      const spec = object(raw, "details");
      const items = rowsOf(spec.items, "items").map((item, index) => {
        const path = `items[${index}].value`;
        const value = item.value;
        const ref = reference(value, path);
        const type =
          item.type ??
          (typeof value === "number" && Number.isFinite(value) ? "number" : value instanceof Date ? "datetime" : ref ? "ref" : "text");
        if (value == null) return { ...item, type, value: null };
        if (value instanceof Date) {
          const time = wallClock(value, context.timeZone, path);
          return { ...item, type, value: type === "date" ? time.slice(0, 10) : time };
        }
        if (ref) return { ...item, type, value: ref };
        if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return { ...item, type, value };
        return invalid(path, "Unsupported cell; convert it to text or a number, or use a Cloud reference {type, id, title?}.");
      });
      return save({ ...spec, view: "details", items });
    },
    async explorer(raw: unknown): Promise<ViewRef> {
      available();
      return save(convertDataset(raw, "explorer"));
    },
    async table(raw: unknown): Promise<ViewRef> {
      available();
      return save(convertDataset(raw, "table"));
    },
  };
}
