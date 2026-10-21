import { z } from "zod";
import { sqlTimestamp } from "./sql-result-values";
import type { SqlRows } from "./store/sql-run";

export const OverviewNumberSchema = z.object({
  value: z.number().finite(),
  valueAt: z.string().datetime().nullable(),
  unit: z.string(),
  detail: z.string(),
  detailTone: z.enum(["neutral", "success", "warning", "danger"]),
  points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).max(10_000),
  truncated: z.boolean(),
});
export type OverviewNumber = z.infer<typeof OverviewNumberSchema>;
export type OverviewNumberResult =
  | { ok: true; data: OverviewNumber }
  | { ok: false; code: "NO_DATA" | "INVALID_COLUMNS" | "INVALID_VALUE" };
const unwrap = (type: string): string => {
  const wrapper = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(type);
  return wrapper ? unwrap(wrapper[1]!) : type;
};
const numeric = /^(?:U?Int\d+|Float\d+|Decimal(?:\d+)?(?:\([^)]*\))?)$/;
const datetime = /^DateTime(?:64)?(?:\([^)]*\))?$/;
const valueOf = (raw: unknown, type: string): number => {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && (!/^U?Int/.test(unwrap(type)) || Number.isSafeInteger(value)) ? value : Number.NaN;
};

/** The last returned row is the value, never an inferred aggregation or a
 * backwards search for a nicer value. Optional presentation columns are data. */
export const readOverviewNumber = (result: Pick<SqlRows, "columns" | "rows" | "truncated">): OverviewNumberResult => {
  const last = result.rows.at(-1);
  if (!last) return { ok: false, code: "NO_DATA" };
  const timeIndex = result.columns.findIndex((column) => datetime.test(unwrap(column.type)));
  const valueIndex = result.columns.findIndex((column) => numeric.test(unwrap(column.type)));
  if (valueIndex < 0) return { ok: false, code: "INVALID_COLUMNS" };
  const timeType = result.columns[timeIndex]?.type ?? "DateTime";
  const valueType = result.columns[valueIndex]!.type;
  const value = valueOf(last[valueIndex], valueType);
  const at = timeIndex < 0 ? null : sqlTimestamp(last[timeIndex], timeType);
  if (!Number.isFinite(value) || (at !== null && !Number.isFinite(new Date(at).getTime()))) return { ok: false, code: "INVALID_VALUE" };
  const text = (name: string) => {
    const index = result.columns.findIndex((column) => column.name === name && unwrap(column.type) === "String");
    const value = index < 0 ? undefined : last[index];
    return typeof value === "string" ? value : "";
  };
  const tone = text("detailTone");
  return {
    ok: true,
    data: {
      value,
      valueAt: at === null ? null : new Date(at).toISOString(),
      unit: text("unit"),
      detail: text("detail"),
      detailTone: tone === "success" || tone === "warning" || tone === "danger" ? tone : "neutral",
      points: result.rows.flatMap((row) => {
        const x = sqlTimestamp(row[timeIndex], timeType),
          y = valueOf(row[valueIndex], valueType);
        return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
      }),
      truncated: result.truncated,
    },
  };
};
