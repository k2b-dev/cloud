import { Chart, Paper, createChartCursor, type ChartTooltipFormatter } from "@k2b/ui";
import { DemoCard } from "./DemoCard";

const start = Date.UTC(2026, 8, 13, 17, 15);
const times = Array.from({ length: 41 }, (_, i) => start + i * 30_000);
const time = (x: number) => new Date(x).toISOString().slice(11, 19);
const services = ["Frontend", "Gateway", "Catalog", "Checkout"];
const latency = services.map((label, series) => ({
  label,
  data: times.flatMap((x, i) =>
    series === 3 && i >= 18 && i <= 21
      ? []
      : [
          {
            x,
            y: Math.round(35 + series * 14 + Math.abs(Math.sin(i * 1.7 + series)) * 70 + (i === 9 || i === 27 ? 1200 / (series + 1) : 0)),
          },
        ],
  ),
}));
const requests = [
  {
    label: "Requests / min",
    data: times.map((x, i) => ({ x, y: Math.round(600 + Math.sin(i * 2.1) * 260 + (i === 9 || i === 27 ? 550 : 0)) })),
  },
];
const errors = [{ label: "Error rate", data: times.map((x, i) => ({ x, y: i === 9 || i === 27 ? 3.8 : i % 7 === 0 ? 0.7 : 0 })) }];
const tooltip =
  (unit: string): ChartTooltipFormatter =>
  ({ datum }) => ({
    rows: [{ label: datum.label ?? "Value", value: `${datum.values.find((field) => field.key === "y")?.value ?? "—"} ${unit}` }],
  });

export default function ChartMonitoringDemo() {
  const cursor = createChartCursor({ formatX: (x) => `13 Sep 2026 · ${time(x)} UTC` });
  const xAxis = { domain: [times[0]!, times.at(-1)!] as [number, number], format: (x: number) => time(x).slice(0, 5) };
  return (
    <DemoCard
      id="chart-monitoring"
      chip={{ kind: "component", name: "createChartCursor", from: "@k2b/ui" }}
      description="Synthetic service monitoring. Hover any plot to compare latency, traffic and errors at the same time. Use arrow keys to inspect, Escape to dismiss. Checkout has a deliberate data gap."
      code={
        'const cursor = createChartCursor({ formatX: formatTime });\n<Chart kind="line" series={latency} cursor={cursor} interactive />\n<Chart kind="line" series={requests} cursor={cursor} interactive />\n<Chart kind="line" series={errors} cursor={cursor} interactive />'
      }
    >
      <div class="ui-demo-monitoring">
        <Paper class="ui-demo-monitoring__wide" style={{ padding: "1rem" }}>
          <h3>p95 latency by service</h3>
          <p>Response times for four services.</p>
          <Chart
            kind="line"
            smooth={false}
            legend
            series={latency}
            xAxis={xAxis}
            yAxis={{ domain: [0, 1500], format: (y) => `${y} ms` }}
            tooltip={tooltip("ms")}
            cursor={cursor}
            interactive
            style={{ height: "18rem" }}
          />
        </Paper>
        <Paper style={{ padding: "1rem", "min-width": "0" }}>
          <h3>Request rate</h3>
          <p>Requests per minute across all services.</p>
          <Chart
            kind="line"
            smooth={false}
            legend
            class="ui-demo-monitoring__requests"
            series={requests}
            xAxis={xAxis}
            yAxis={{ domain: [0, 1500], format: (y) => (y >= 1000 ? `${y / 1000}k` : String(y)) }}
            tooltip={tooltip("/min")}
            cursor={cursor}
            interactive
            style={{ height: "15rem" }}
          />
        </Paper>
        <Paper style={{ padding: "1rem", "min-width": "0" }}>
          <h3>Error rate</h3>
          <p>Share of requests that failed.</p>
          <Chart
            kind="line"
            smooth={false}
            legend
            class="ui-demo-monitoring__errors"
            series={errors}
            xAxis={xAxis}
            yAxis={{ domain: [0, 5], format: (y) => `${y}%` }}
            tooltip={tooltip("%")}
            cursor={cursor}
            interactive
            style={{ height: "15rem" }}
          />
        </Paper>
      </div>
    </DemoCard>
  );
}
