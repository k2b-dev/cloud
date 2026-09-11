import { Chart, type ChartProps, RangePicker } from "@k2b/ui";
import { createSignal, For, onMount } from "solid-js";

const otherCharts: ChartProps[] = [
  {
    kind: "bar",
    data: [
      { label: "One", value: 20 },
      { label: "Two", value: 30 },
    ],
    showValues: true,
  },
  {
    kind: "pie",
    data: [
      { label: "One", value: 20 },
      { label: "Two", value: 30 },
    ],
  },
  { kind: "histogram", data: [1, 1, 2, 3, 5, 8] },
  { kind: "boxplot", groups: [{ label: "One", values: [1, 2, 3, 4, 100] }] },
  { kind: "gauge", value: 65, label: "Load", unit: "%" },
  { kind: "barGauge", data: [{ label: "Load", value: 65 }] },
  { kind: "stat", label: "Requests", value: 1234, delta: 12, sparkline: [1, 3, 2, 4] },
  {
    kind: "heatmap",
    data: [
      { x: "One", y: "A", value: 20 },
      { x: "Two", y: "A", value: 30 },
    ],
    showValues: true,
  },
  { kind: "sparkline", data: [1, 3, 2, 4], showLast: true, showMinMax: true, style: { height: "32px" } },
];

export default function ChartFixture(props: { window: "1h" | "24h" }) {
  const [hydrated, setHydrated] = createSignal(false);
  const [offset, setOffset] = createSignal(0);
  onMount(() => setHydrated(true));
  const series = () => [{ label: "Requests", data: [12, 28, 24, 42].map((y, x) => ({ x: x + 1, y: y + offset() })) }];
  return (
    <main class="k2b-ui" data-hydrated={hydrated()} style={{ padding: "24px", display: "grid", gap: "24px" }}>
      <RangePicker
        value={props.window}
        options={[
          { value: "1h", href: "?window=1h" },
          { value: "24h", href: "?window=24h" },
        ]}
      />
      <button type="button" onClick={() => setOffset((value) => value + 5)}>
        Update data
      </button>
      <Chart kind="line" style={{ height: "224px" }} series={series()} yAxis={{ label: "Requests" }} legend interactive />
      <Chart kind="map" style={{ height: "224px" }} series={[{ data: [{ latitude: 52.52, longitude: 13.405 }] }]} interactive />
      <Chart
        kind="stateTimeline"
        rows={[
          {
            label: "Worker",
            intervals: [
              { from: 0, to: 4, state: "ok" },
              { from: 5, to: 8, state: "busy" },
            ],
          },
        ]}
        states={[
          { state: "ok", label: "Healthy" },
          { state: "busy", label: "Running" },
        ]}
        domain={[0, 10]}
        interactive
      />
      <Chart
        kind="scatter"
        style={{ height: "224px" }}
        series={[...series(), { label: "Other", marker: "triangle", data: [{ x: 2, y: 15 }] }]}
        legend
      />
      <Chart
        kind="donut"
        style={{ height: "224px" }}
        data={[
          { label: "One", value: 20 },
          { label: "Two", value: 30 },
        ]}
        legend
      />
      <For each={otherCharts}>{(options) => <Chart {...options} style={options.style ?? { height: "224px" }} />}</For>
      <p id="after-charts">Content after the charts</p>
    </main>
  );
}
