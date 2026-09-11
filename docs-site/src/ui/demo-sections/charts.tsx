import { Chart, type ChartKind, type ChartProps, type ChartSelection, type ChartTooltipFormatter, RangePicker } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { DemoCard } from "../DemoCard";

const examples = {
  line: {
    description: "Line · Requests rise from 12 to 42 per second. Inspect individual points with the pointer or keyboard.",
    chart: {
      kind: "line",
      series: [
        {
          label: "Requests",
          data: [
            { x: 1, y: 12 },
            { x: 2, y: 28 },
            { x: 3, y: 24 },
            { x: 4, y: 42 },
          ],
        },
      ],
      xAxis: { label: "Time (h)" },
      legend: true,
      smooth: true,
      interactive: true,
    },
  },
  scatter: {
    description: "Scatter · Latency in milliseconds increases with payload size in KB. Compare cached and uncached requests.",
    chart: {
      kind: "scatter",
      series: [
        {
          label: "Cached",
          data: [
            { x: 10, y: 18 },
            { x: 25, y: 24 },
            { x: 40, y: 29 },
            { x: 60, y: 38 },
          ],
        },
        {
          label: "Uncached",
          marker: "triangle",
          data: [
            { x: 10, y: 32 },
            { x: 25, y: 48 },
            { x: 40, y: 62 },
            { x: 60, y: 85 },
          ],
        },
      ],
      xAxis: { label: "Payload (KB)" },
      legend: true,
    },
  },
  bar: {
    description: "Bar · Compare daily jobs by queue. Imports has the highest volume at 42 jobs.",
    chart: {
      kind: "bar",
      data: [
        { label: "Imports", value: 42 },
        { label: "Exports", value: 28 },
        { label: "Reports", value: 18 },
      ],
      colorByBar: true,
      showValues: true,
    },
  },
  pie: {
    description: "Pie · Web accounts for 60% of traffic, followed by mobile at 30% and integrations at 10%.",
    chart: {
      kind: "pie",
      data: [
        { label: "Web", value: 60 },
        { label: "Mobile", value: 30 },
        { label: "API", value: 10 },
      ],
      showLabels: true,
      legend: true,
    },
  },
  donut: {
    description: "Donut · 72 jobs succeeded, 20 are running, and 8 are waiting.",
    chart: {
      kind: "donut",
      data: [
        { label: "Succeeded", value: 72 },
        { label: "Running", value: 20 },
        { label: "Waiting", value: 8 },
      ],
      showLabels: true,
      legend: true,
    },
  },
  sparkline: {
    description: "Sparkline · A minute-by-minute request-rate trend with its minimum, maximum, and latest point marked.",
    chart: {
      kind: "sparkline",
      data: [12, 18, 15, 28, 24, 32, 29, 42],
      smooth: true,
      area: true,
      showLast: true,
      showMinMax: true,
      style: { height: "4rem" },
    },
  },
  histogram: {
    description: "Histogram · Most responses finish within 20–50 ms; a few take over 80 ms.",
    chart: {
      kind: "histogram",
      data: [12, 18, 22, 24, 25, 28, 30, 31, 33, 35, 38, 40, 42, 45, 48, 54, 62, 85, 92],
      bins: [0, 20, 40, 60, 80, 100],
      xAxis: { label: "Latency (ms)" },
    },
  },
  boxplot: {
    description: "Boxplot · Compare latency distributions in milliseconds across regions, including unusually slow requests.",
    chart: {
      kind: "boxplot",
      groups: [
        { label: "Europe", values: [18, 20, 22, 24, 25, 28, 30, 32, 75] },
        { label: "US", values: [28, 32, 35, 38, 40, 42, 45, 48, 95] },
        { label: "Asia", values: [40, 45, 48, 50, 52, 55, 58, 62, 110] },
      ],
      showOutliers: true,
      colorByBox: true,
    },
  },
  gauge: {
    description: "Gauge · CPU utilization is 65%, below the warning threshold of 70%.",
    chart: {
      kind: "gauge",
      value: 65,
      min: 0,
      max: 100,
      label: "CPU",
      unit: "%",
      thresholds: [
        { value: 0, color: "#10b981" },
        { value: 70, color: "#f59e0b" },
        { value: 90, color: "#ef4444" },
      ],
      showNeedle: true,
    },
  },
  barGauge: {
    description: "Bar gauge · Compare resource utilization on a shared 0–100% scale. Memory is highest at 72%.",
    chart: {
      kind: "barGauge",
      data: [
        { label: "CPU", value: 65 },
        { label: "Memory", value: 72 },
        { label: "Disk", value: 38 },
      ],
      min: 0,
      max: 100,
      unit: "%",
    },
  },
  stat: {
    description: "Stat · 1,284 requests, up 12% from the previous period, with a compact history.",
    chart: {
      kind: "stat",
      label: "Requests",
      value: 1284,
      delta: "+12%",
      trend: "up",
      sparkline: [820, 940, 910, 1080, 1020, 1160, 1284],
      style: { height: "10rem" },
    },
  },
  heatmap: {
    description: "Heatmap · Request volume by region and day. Europe peaks on Wednesday at 48 requests.",
    chart: {
      kind: "heatmap",
      data: [
        { x: "Mon", y: "EU", value: 24 },
        { x: "Tue", y: "EU", value: 36 },
        { x: "Wed", y: "EU", value: 48 },
        { x: "Mon", y: "US", value: 18 },
        { x: "Tue", y: "US", value: 32 },
        { x: "Wed", y: "US", value: 28 },
        { x: "Mon", y: "Asia", value: 12 },
        { x: "Tue", y: "Asia", value: 22 },
        { x: "Wed", y: "Asia", value: 30 },
      ],
      showValues: true,
    },
  },
  map: {
    description: "Map · Request locations in Berlin, New York, and Tokyo. Pan, zoom, or reset the geographic view.",
    chart: {
      kind: "map",
      series: [
        {
          label: "Requests",
          data: [
            { latitude: 52.52, longitude: 13.405, label: "Berlin" },
            { latitude: 40.713, longitude: -74.006, label: "New York" },
            { latitude: 35.676, longitude: 139.65, label: "Tokyo" },
          ],
        },
      ],
      interactive: true,
    },
  },
  stateTimeline: {
    description:
      "State timeline · Worker A runs from hour 4 to 8; Worker B has an error from hour 6 to 7. Inspect intervals and zoom into the history. Height follows the row count.",
    chart: {
      kind: "stateTimeline",
      rows: [
        {
          label: "A",
          intervals: [
            { from: 0, to: 4, state: "ok", tooltip: "Healthy" },
            { from: 4, to: 8, state: "running", tooltip: "Processing imports" },
            { from: 8, to: 10, state: "ok", tooltip: "Healthy" },
          ],
        },
        {
          label: "B",
          intervals: [
            { from: 0, to: 6, state: "ok", tooltip: "Healthy" },
            { from: 6, to: 7, state: "error", tooltip: "Connection lost" },
            { from: 7, to: 10, state: "ok", tooltip: "Recovered" },
          ],
        },
      ],
      states: [
        { state: "ok", label: "Healthy", color: "#10b981" },
        { state: "running", label: "Running", color: "#3b82f6" },
        { state: "error", label: "Error", color: "#ef4444" },
      ],
      domain: [0, 10],
      interactive: true,
    },
  },
} satisfies { [K in ChartKind]: { description: string; chart: Extract<ChartProps, { kind: K }> } };

type TooltipField = { label: string; unit?: string; names?: Record<string, string> };
type TooltipExample = { title: string; fields: Record<string, TooltipField> };

const tooltipExamples: Record<ChartKind, TooltipExample> = {
  line: { title: "Request rate", fields: {
    x: { label: "Time elapsed", unit: " h" }, y: { label: "Throughput", unit: " requests/s" },
  } },
  scatter: { title: "Response latency", fields: {
    x: { label: "Payload size", unit: " KB" }, y: { label: "Response time", unit: " ms" },
  } },
  bar: { title: "Daily queue volume", fields: { value: { label: "Jobs today", unit: " jobs" } } },
  pie: { title: "Traffic by channel", fields: { percent: { label: "Share of traffic", unit: "%" } } },
  donut: { title: "Job progress", fields: {
    value: { label: "Jobs", unit: " jobs" }, percent: { label: "Share of all jobs", unit: "%" },
  } },
  sparkline: { title: "Request history", fields: {
    x: { label: "Minutes elapsed", unit: " min" }, y: { label: "Request rate", unit: " requests/s" },
  } },
  histogram: { title: "Response-time distribution", fields: {
    from: { label: "Latency from", unit: " ms" }, to: { label: "Latency to", unit: " ms" },
    upperInclusive: { label: "Upper bound included", names: { true: "Yes", false: "No" } },
    count: { label: "Responses in this range", unit: " responses" },
  } },
  boxplot: { title: "Regional response times", fields: {
    count: { label: "Requests measured" }, q1: { label: "25th percentile", unit: " ms" },
    q2: { label: "Median response time", unit: " ms" }, q3: { label: "75th percentile", unit: " ms" },
    whiskerLow: { label: "Lower whisker", unit: " ms" }, whiskerHigh: { label: "Upper whisker", unit: " ms" },
    value: { label: "Outlier response time", unit: " ms" },
  } },
  gauge: { title: "Processor utilization", fields: {
    value: { label: "CPU in use", unit: "%" }, max: { label: "Total capacity", unit: "%" },
  } },
  barGauge: { title: "Resource utilization", fields: {
    value: { label: "Capacity in use", unit: "%" }, max: { label: "Total capacity", unit: "%" },
  } },
  stat: { title: "Request volume", fields: {
    value: { label: "Current period", unit: " requests" }, delta: { label: "Change from previous period" },
    x: { label: "Periods elapsed" }, y: { label: "Requests in this period", unit: " requests" },
  } },
  heatmap: { title: "Daily regional traffic", fields: {
    x: { label: "Day", names: { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday" } },
    y: { label: "Region", names: { EU: "Europe", US: "United States", Asia: "Asia" } },
    value: { label: "Requests received", unit: " requests" },
  } },
  map: { title: "Request location", fields: {
    latitude: { label: "Latitude", unit: "°" }, longitude: { label: "Longitude", unit: "°" },
  } },
  stateTimeline: { title: "Worker activity", fields: {
    state: { label: "Worker status", names: { ok: "Healthy", running: "Running", error: "Error" } },
    from: { label: "Started at", unit: " h" }, to: { label: "Ended at", unit: " h" },
    duration: { label: "Time in this state", unit: " h" }, detail: { label: "Activity" },
  } },
};

const createTooltip = (example: TooltipExample): ChartTooltipFormatter => ({ datum }) => ({
  title: datum.label ? `${example.title} · ${datum.label}` : example.title,
  rows: datum.values.flatMap(({ key, value }) => {
    const field = example.fields[key];
    if (!field) return [];
    const text = field.names?.[String(value)]
      ?? (typeof value === "number" ? value.toLocaleString("en", { maximumFractionDigits: 2 }) : value);
    return [{ label: field.label, value: `${text}${field.unit ?? ""}` }];
  }),
});

// Keep each copied example self-contained, including its domain labels and units.
const tooltipCode = (example: TooltipExample) => `const tooltipFields: Record<string, { label: string; unit?: string; names?: Record<string, string> }> = ${JSON.stringify(example.fields, null, 2)};

const tooltip: ChartTooltipFormatter = ({ datum }) => ({
  title: datum.label ? ${JSON.stringify(example.title + " · ")} + datum.label : ${JSON.stringify(example.title)},
  rows: datum.values.flatMap(({ key, value }) => {
    const field = tooltipFields[key];
    if (!field) return [];
    const text = field.names?.[String(value)]
      ?? (typeof value === "number" ? value.toLocaleString("en", { maximumFractionDigits: 2 }) : value);
    return [{ label: field.label, value: text + (field.unit ?? "") }];
  }),
});`;

const gallery = Object.values(examples).map(({ description, chart }) => ({
  description,
  chart: {
    ...(chart.kind === "stateTimeline" ? {} : { style: { height: "14rem" } }),
    ...chart,
    interactive: true,
  },
}));

export const ChartDemo = (props: { window: "1h" | "24h" }) => (
  <For each={gallery}>
    {(example) => {
      const [selection, setSelection] = createSignal<ChartSelection>();
      const tooltip = createTooltip(tooltipExamples[example.chart.kind]);
      return (
        <DemoCard
          id={example.chart.kind === "line" ? "charts" : `charts-${example.chart.kind}`}
          chip={{ kind: "component", name: `Chart · ${example.chart.kind}`, from: "@k2b/ui" }}
          description={example.description}
          code={`import { Chart, type ChartTooltipFormatter } from "@k2b/ui";\n\n${tooltipCode(tooltipExamples[example.chart.kind])}\n\n<Chart\n  {...${JSON.stringify(example.chart, null, 2).replaceAll("\n", "\n  ")}}\n  tooltip={tooltip}\n  onSelect={(selection) => console.log(selection)}\n/>`}
        >
          <div class="ui-chart-demo">
            <Show when={example.chart.kind === "line"}>
              <RangePicker
                value={props.window}
                options={[
                  { value: "1h", href: "?window=1h" },
                  { value: "24h", href: "?window=24h" },
                ]}
              />
            </Show>
            <p>Hover or tap to inspect. Use arrow keys, or Alt + arrow keys on maps and timelines. Enter selects; Escape dismisses.</p>
            <Chart {...example.chart} tooltip={tooltip} onSelect={setSelection} />
            <output aria-live="polite" style={{ display: "block", "min-height": "2rem" }}>
              {selection()
                ? `Selected: ${tooltip(selection()!).title} — ${tooltip(selection()!).rows.map((row) => `${row.label}: ${row.value}`).join(" · ")}`
                : "Select a data point to see its details here."}
            </output>
          </div>
        </DemoCard>
      );
    }}
  </For>
);
