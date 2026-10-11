import { computeDomain, niceStep } from "@k2b/stdlib";
import { z } from "zod";
import type { RuntimeContext } from "./cloud";
import { CloudError } from "./errors";

const viewRefSchema = () =>
  z.discriminatedUnion("view", [
    z.object({
      path: z.string().startsWith("/views/").endsWith(".view.json"),
      view: z.literal("chart"),
      kind: z.enum(["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline"]),
      title: z.string(),
      subtitle: z.string().optional(),
    }),
    z.object({
      path: z.string().startsWith("/views/").endsWith(".view.json"),
      view: z.literal("table"),
      title: z.string(),
      subtitle: z.string().optional(),
      rows: z.number().int().nonnegative().max(3840),
      footer: z.boolean(),
      columns: z.number().int().min(1).max(100),
    }),
  ]);
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
const rowsOf = (value: unknown): Row[] => {
  if (!Array.isArray(value)) return invalid("rows", "Expected an array of objects.");
  return value.map((row, index) => object(row, `rows[${index}]`));
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

function histogram(values: number[], bins: unknown, locale: string) {
  if (!values.length) return invalid("rows", "A histogram needs at least one number.");
  let min = Infinity,
    max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const format = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 });
  let edges: number[];
  if (Array.isArray(bins)) {
    edges = bins.map((value, index) => number(value, `bins[${index}]`));
    if (edges.length < 2 || edges.length > 481 || edges.some((edge, index) => index > 0 && edge <= edges[index - 1]!))
      return invalid("bins", "Use 2..481 ascending finite edges.");
    if (edges[0]! > min || edges[edges.length - 1]! < max) return invalid("bins", "Edges must cover every observation.");
  } else {
    const count = bins === undefined ? Math.min(480, Math.ceil(Math.log2(values.length)) + 1) : number(bins, "bins");
    if (!Number.isInteger(count) || count < 1 || count > 480) return invalid("bins", "Use a bin count from 1 to 480.");
    if (min === max) return [{ label: format.format(min), value: values.length }];
    const domain = computeDomain([min, max]);
    let step = niceStep(domain[1] - domain[0], count);
    if (!Number.isFinite(step) || step <= 0 || min + step === min)
      return invalid("bins", "Values cannot form finite bin edges; subtract a common offset first.");
    let low = Math.floor(min / step) * step;
    let size = Math.ceil((max - low) / step);
    // Rounding the step down may exceed the chart's mark budget.
    if (size > 480) {
      step = niceStep(domain[1] - domain[0], count / 2);
      low = Math.floor(min / step) * step;
      size = Math.ceil((max - low) / step);
    }
    if (size > 480 || !Number.isFinite(size)) return invalid("bins", "At most 480 bins are allowed.");
    edges = Array.from({ length: size + 1 }, (_, index) => low + index * step);
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
  return {
    async chart(raw: unknown): Promise<ViewRef> {
      available();
      const spec = object(raw, "chart");
      if (spec.rows === undefined) return save({ ...spec, view: "chart" });
      const { rows: input, x, y, value, bins, series, ...options } = spec;
      const rows = rowsOf(input);
      const values = (id: string) =>
        rows.flatMap((row, index) => (cellOf(row, id) == null ? [] : [number(cellOf(row, id), `rows[${index}].${id}`)]));
      if (spec.kind === "gauge") return invalid("rows", "A gauge takes a value, not rows.");
      if (spec.kind === "histogram")
        return save({ ...options, view: "chart", kind: "bar", data: histogram(values(columnId(value, "value")), bins, context.locale) });
      const ys = Array.isArray(y) ? y.map((id, index) => columnId(id, `y[${index}]`)) : [columnId(y, "y")];
      if (spec.kind === "sparkline") {
        if (ys.length !== 1) return invalid("y", "Choose one value column.");
        return save({ ...options, view: "chart", data: values(ys[0]!) });
      }
      const label = columnId(x, "x");
      if (spec.kind === "bar" || spec.kind === "pie" || spec.kind === "donut") {
        if (ys.length !== 1) return invalid("y", "Choose one value column.");
        return save({
          ...options,
          view: "chart",
          data: rows.flatMap((row, index) =>
            cellOf(row, ys[0]!) == null
              ? []
              : [{ label: String(cellOf(row, label)), value: number(cellOf(row, ys[0]!), `rows[${index}].${ys[0]}`) }],
          ),
        });
      }
      if (spec.kind !== "line" && spec.kind !== "scatter") return invalid("kind", "Unknown chart kind.");
      if (series !== undefined && ys.length !== 1) return invalid("series", "Long format needs one y column.");
      const group = series === undefined ? undefined : columnId(series, "series");
      const grouped = new Map<unknown, { label: string; data: { x: string | number; y: number }[] }>();
      for (const [index, row] of rows.entries())
        for (const id of ys) {
          if (cellOf(row, id) == null) continue;
          const key = group ? cellOf(row, group) : id;
          let entry = grouped.get(key);
          if (!entry) {
            entry = { label: String(key), data: [] };
            grouped.set(key, entry);
          }
          const cell = cellOf(row, label);
          const pointX =
            cell instanceof Date
              ? wallClock(cell, context.timeZone, `rows[${index}].${label}`)
              : typeof cell === "string"
                ? cell
                : number(cell, `rows[${index}].${label}`);
          entry.data.push({ x: pointX, y: number(cellOf(row, id), `rows[${index}].${id}`) });
        }
      return save({ ...options, view: "chart", series: [...grouped.values()] });
    },
    async table(raw: unknown): Promise<ViewRef> {
      available();
      const spec = object(raw, "table");
      const rows = rowsOf(spec.rows);
      const inputColumns = spec.columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
      if (!Array.isArray(inputColumns)) return invalid("columns", "Expected column names or objects.");
      const columns = inputColumns.map((raw, index) => {
        const column = typeof raw === "string" ? { id: raw } : object(raw, `columns[${index}]`);
        const id = columnId(column.id, `columns[${index}].id`);
        const cells = rows.map((row) => cellOf(row, id)).filter((cell) => cell != null);
        const type =
          column.type ??
          (cells.every((cell) => typeof cell === "number") ? "number" : cells.every((cell) => cell instanceof Date) ? "datetime" : "text");
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
            return invalid(`${path}.${id}`, "Unsupported cell; convert it to text or a number.");
          }),
        );
      return save({
        ...spec,
        view: "table",
        columns,
        rows: rows.map((row, index) => normalize(row, `rows[${index}]`)),
        ...(spec.footer === undefined ? {} : { footer: normalize(object(spec.footer, "footer"), "footer") }),
      });
    },
  };
}
