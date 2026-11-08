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
      kind: "waterfall";
      start: { label: string; value: number };
      steps: { label: string; value: number }[];
      end: { label: string };
      format?: ChartNumberFormat;
    }
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
      x?: string[];
      series?: { label: string; data: (number | null)[] }[];
      /** Rows accept signed values. Ordered categories and legacy drawing options retain the original row renderer. */
      layout?: "columns" | "rows" | "grouped" | "stacked";
      normalize?: boolean;
      share?: boolean;
      limit?: number;
      tone?: "in" | "out";
      format?: ChartNumberFormat;
      compare?: { label: string; data: (number | null)[] };
      xAxis?: Pick<ChartDescriptionAxis, "label"> & { ordered?: boolean };
      yAxis?: ChartDescriptionAxis;
      colorByBar?: boolean;
      showValues?: boolean;
      legend?: boolean;
      references?: Reference[];
    }
  | { kind: "funnel"; data: { label: string; value: number | null }[]; format?: ChartNumberFormat }
  | {
      kind: "hbar";
      series: string[];
      rows: { group?: string; label: string; values: (number | null)[] }[];
      legend?: boolean;
      format?: ChartNumberFormat;
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
  | { kind: "stat"; value: N; format?: ChartNumberFormat; unit?: string; delta?: N; better?: "up" | "down"; sparkline?: N[] }
  | {
      kind: "treemap";
      groups: string[];
      data: { label: string; group: string; value: number }[];
      legend?: boolean;
      format?: ChartNumberFormat;
      locale?: string;
    }
  | {
      kind: "pareto";
      labels: [string, string];
      data: { label: string; value: number; prev: number; rest?: boolean }[];
      format?: ChartNumberFormat;
      locale?: string;
    }
  | {
      kind: "bubble";
      groups: string[];
      data: { label: string; group: string; x: number; y: number; size?: number }[];
      xLabel: string;
      yLabel: string;
      sizeLabel?: string;
      averages?: boolean;
      legend?: boolean;
      xFormat?: ChartNumberFormat;
      yFormat?: ChartNumberFormat;
      format?: ChartNumberFormat;
      locale?: string;
    }
  | {
      kind: "radar";
      axes: string[];
      max: number;
      unit?: string;
      series: { label: string; data: number[] }[];
      format?: ChartNumberFormat;
      legend?: boolean;
      locale?: string;
    };

/** Portable chart node. Dates are ISO text and missing observations are null, never zero. */
export type ChartDescription = Common &
  (
    | Exclude<Variants<number | null>, { kind: "bar" }>
    // Aligned series omit flat data; the validator supplies an empty array.
    | (Omit<Extract<Variants<number | null>, { kind: "bar" }>, "data"> & { data?: { label: string; value: number | null }[] })
  );
/** Validated renderer input. The portable validator normalizes null gaps to non-finite numbers for drawing. */
export type ChartInput = Common &
  (
    | Exclude<Variants<number>, { kind: "stat" }>
    | (Omit<Extract<Variants<number>, { kind: "stat" }>, "delta"> & { delta: number | undefined })
  );
