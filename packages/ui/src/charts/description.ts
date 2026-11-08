/** JSON number formatting. Functions belong to the rendering host, never the saved description. */
export type ChartNumberFormat = {
  style?: "number" | "percent" | "currency";
  currency?: string;
  unit?: string;
  decimals?: number;
  compact?: boolean;
};
export type ChartDateFormat = { date: "day" | "minute" | "second" };
export type ChartFormat = ChartNumberFormat | ChartDateFormat;
export type ChartLimits = { maxSeries: number; maxValues: number; maxMarks: number };
export type ChartDescriptionAxis = {
  label?: string;
  domain?: number[];
  ticks?: number;
  scale?: "linear" | "log";
  format?: ChartFormat;
};
type Reference = {
  value: number | string;
  axis?: "x" | "y";
  label?: string;
  style?: "solid" | "dashed" | "dotted";
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
};
type Threshold = { value: number; label?: string };
type Series<N> = { label?: string; data: { x: N | string; y: N }[]; role?: "reference" };
type Common = { title: string; subtitle?: string; tooltip?: { label?: string; format?: ChartNumberFormat } };
type Variants<N> =
  | {
      kind: "area";
      layout: "stacked";
      normalize?: boolean;
      x: (number | string)[];
      series: { label: string; data: (number | null)[] }[];
      legend?: boolean;
      format?: ChartNumberFormat;
    }
  | {
      kind: "bar";
      data: { label: string; value: N }[];
      xAxis?: Pick<ChartDescriptionAxis, "label">;
      yAxis?: ChartDescriptionAxis;
      colorByBar?: boolean;
      showValues?: boolean;
      legend?: boolean;
      references?: Reference[];
    }
  | {
      kind: "line";
      series: (Series<N> & { style?: "solid" | "dashed" | "dotted" })[];
      xAxis?: ChartDescriptionAxis;
      yAxis?: ChartDescriptionAxis;
      legend?: boolean;
      area?: boolean;
      smooth?: boolean;
      step?: "after" | "before" | "middle";
      zero?: boolean;
      legendValues?: boolean;
      forecast?: { from: number | string; band?: [number, number][] };
      threshold?: { value: number; label: string };
      marker?: { at: number | string; label: string };
      references?: Reference[];
    }
  | {
      kind: "scatter";
      series: Series<N>[];
      xAxis?: ChartDescriptionAxis;
      yAxis?: ChartDescriptionAxis;
      legend?: boolean;
      references?: Reference[];
    }
  | { kind: "pie" | "donut"; data: { label: string; value: N }[]; legend?: boolean; showLabels?: boolean; format?: ChartNumberFormat }
  | { kind: "histogram"; data: N[]; bins?: number | number[]; references?: Reference[] }
  | {
      kind: "gauge";
      value: N;
      min?: number;
      max?: number;
      label?: string;
      unit?: string;
      format?: ChartNumberFormat;
      thresholds?: Threshold[];
    }
  | { kind: "sparkline"; data: N[]; area?: boolean }
  | { kind: "boxplot"; data: { label: string; values: N[] }[]; yAxis?: ChartDescriptionAxis; references?: Reference[] }
  | {
      kind: "heatmap";
      layout: "calendar";
      data: [string, N | null][];
      scale: "sequential" | "diverging";
      label?: string;
      format?: ChartNumberFormat;
      locale?: string;
    }
  | {
      kind: "heatmap";
      layout?: undefined;
      data: { x: string; y: string; value: N }[];
      format?: ChartNumberFormat;
      showValues?: boolean;
      min?: number;
      max?: number;
    }
  | {
      kind: "barGauge";
      data: { label: string; value: N; min?: number; max?: number }[];
      min?: number;
      max?: number;
      unit?: string;
      format?: ChartNumberFormat;
      thresholds?: Threshold[];
    }
  | { kind: "stat"; value: N; format?: ChartNumberFormat; unit?: string; delta?: N; better?: "up" | "down"; sparkline?: N[] };

/** Portable chart node. Dates are ISO text and missing observations are null, never zero. */
export type ChartDescription = Common & Variants<number | null>;
/** Validated renderer input. The portable validator normalizes null gaps to non-finite numbers for drawing. */
export type ChartInput = Common &
  (
    | Exclude<Variants<number>, { kind: "stat" }>
    | (Omit<Extract<Variants<number>, { kind: "stat" }>, "delta"> & { delta: number | undefined })
  );
