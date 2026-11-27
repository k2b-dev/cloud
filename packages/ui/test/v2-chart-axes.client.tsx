import { For } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { Bar, Canvas, Pane, Section, Text, Workspace } from "../src/v2";

// Charts with axes on a v2 screen, as an operations app draws them (Pulse, Venue): a day's values by the hour, from
// 0 to 10, in Canvases of different heights. The lowest value label ("0") stands left of the axis, the first time
// ("07:00") under it at the corner: they must never draw over each other, at any width or height.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const HOUR = 3_600_000;
const start = Date.UTC(2026, 10, 26, 7);
const hours = Array.from({ length: 12 }, (_, hour) => ({ x: start + hour * HOUR, y: [2, 4, 7, 10, 6, 3, 8, 9, 5, 4, 2, 1][hour]! }));
const time = (value: number) => new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" }).format(value);

const charts = [
  { name: "line", height: 120 },
  { name: "line", height: 160 },
  { name: "line", height: 240 },
  { name: "time", height: 120 },
  { name: "area", height: 120 },
  { name: "bar", height: 120 },
] as const;

const root = document.getElementById("root");
if (!root) throw new Error("chart-axes: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Telemetrie</Text>} />}>
      <Pane label="Telemetrie">
        <For each={charts}>
          {(chart) => (
            <Section icon="chart-line" title={`Anfragen je Stunde (${chart.name}, ${chart.height} px)`}>
              <Canvas label={`Anfragen je Stunde, ${chart.name}`} height={chart.height}>
                {chart.name === "time" ? (
                  <Chart
                    kind="line"
                    style={{ height: "100%" }}
                    series={[{ label: "Anfragen", data: hours }]}
                    timeAxis={{ timeZone: "UTC", locale: "de" }}
                    yAxis={{ domain: [0, 10] }}
                  />
                ) : chart.name === "line" ? (
                  <Chart
                    kind="line"
                    style={{ height: "100%" }}
                    series={[{ label: "Anfragen", data: hours }]}
                    xAxis={{ format: time }}
                    yAxis={{ domain: [0, 10] }}
                  />
                ) : chart.name === "area" ? (
                  <Chart
                    kind="area"
                    layout="stacked"
                    style={{ height: "100%" }}
                    legend={false}
                    x={hours.map((point) => time(point.x))}
                    series={[{ label: "Anfragen", data: hours.map((point) => point.y) }]}
                  />
                ) : (
                  <Chart kind="bar" style={{ height: "100%" }} data={hours.map((point) => ({ label: time(point.x), value: point.y }))} />
                )}
              </Canvas>
            </Section>
          )}
        </For>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
