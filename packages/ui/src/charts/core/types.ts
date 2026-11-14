import type { chartRenderers } from "./registry";

/** UI-owned kind union, derived from the renderer registry. */
export type ChartKind = keyof typeof chartRenderers;
export const chartDatumRoles = ["point", "item", "bin", "box", "outlier", "value", "cell", "interval"] as const;
export type ChartDatumRole = (typeof chartDatumRoles)[number];

/** Renderer metadata. Anchors use the containing SVG's coordinate space. */
export type ChartDatum = {
  index: number;
  seriesIndex?: number;
  role: ChartDatumRole;
  label?: string;
  anchor: [number, number];
  grid?: [number, number];
  values: { key: string; value: string | number; formatted?: string; label?: string }[];
};

export type { ChartDateFormat, ChartFormat, ChartNumberFormat } from "../description";
