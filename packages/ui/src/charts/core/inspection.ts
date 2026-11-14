import { type ChartDatum, type ChartKind, chartDatumRoles } from "./types";

export type ChartDatumRef = Pick<ChartDatum, "role" | "index" | "seriesIndex">;
export const sameChartDatum = (a: ChartDatumRef, b: ChartDatumRef) =>
  a.role === b.role && a.index === b.index && a.seriesIndex === b.seriesIndex;

export type ChartSelection = { kind: ChartKind; datum: ChartDatum };
export type ChartTooltip = { title?: string; rows: readonly { label: string; value: string }[] };
export type ChartTooltipFormatter = (selection: ChartSelection) => ChartTooltip;

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const pair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n));
const optionalText = (value: unknown) => value === undefined || typeof value === "string";
const roles: ReadonlySet<string> = new Set(chartDatumRoles);
export function isChartDatum(value: unknown): value is ChartDatum {
  return (
    object(value) &&
    Number.isInteger(value.index) &&
    typeof value.index === "number" &&
    value.index >= 0 &&
    (value.seriesIndex === undefined ||
      (typeof value.seriesIndex === "number" && Number.isInteger(value.seriesIndex) && value.seriesIndex >= 0)) &&
    typeof value.role === "string" &&
    roles.has(value.role) &&
    pair(value.anchor) &&
    (value.grid === undefined || pair(value.grid)) &&
    optionalText(value.label) &&
    Array.isArray(value.values) &&
    value.values.every(
      (field) =>
        object(field) &&
        typeof field.key === "string" &&
        (typeof field.value === "string" || (typeof field.value === "number" && Number.isFinite(field.value))) &&
        optionalText(field.formatted) &&
        optionalText(field.label),
    )
  );
}
