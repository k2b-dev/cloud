import { createSignal, type JSX, Match, Switch } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { Bar, Canvas, Cells, Failed, Loading, Pane, Section, Text, Workspace } from "../src/v2";

// Charts of @k2b/ui inside a v2 screen, as an app builds one: each chart in a Canvas, the Canvas directly in a Section.
// `setChartsState` switches every chart to its empty, loading or failed state; the state stands inside the Canvas, in
// the place of the drawing, and keeps its height.
type State = "data" | "empty" | "loading" | "failed";
const [state, setState] = createSignal<State>("data");
Object.assign(window, { setChartsState: setState });

const months = ["Jun", "Jul", "Aug", "Sep", "Okt", "Nov"];
const intake = [42, 51, 47, 63, 58, 71];
const returns = [8, 11, 9, 14, 12, 10];
// fixed days, so the calendar is the same on every run
const calendarDays = Array.from({ length: 420 }, (_, i): [string, number] => [
  new Date(Date.UTC(2025, 0, 6) + i * 86400000).toISOString().slice(0, 10),
  (i * 17) % 211,
]);

const place = (height: number, label: string, chart: () => JSX.Element) => (
  <Canvas label={label} height={height}>
    <Switch fallback={chart()}>
      <Match when={state() === "loading"}>
        <Loading />
      </Match>
      <Match when={state() === "failed"}>
        <Failed text={`${label} konnte nicht geladen werden.`} onRetry={() => setState("data")} />
      </Match>
    </Switch>
  </Canvas>
);

const empty = () => state() === "empty";

render(
  () => (
    <Workspace head={<Bar start={<Text type="body">Einlieferungen</Text>} />}>
      <Pane label="Einlieferungen">
        <Cells>
          <Cells.Cell icon="package" label="Diesen Monat" value="71" meta="+13 zum Vormonat" />
          <Cells.Cell
            icon="chart-line"
            label="Verlauf"
            value={
              <span class="charts-v2-spark">
                <Chart kind="sparkline" style={{ width: "96px", height: "24px" }} data={empty() ? [] : intake} />
              </span>
            }
            meta="seit Juni"
          />
          <Cells.Cell icon="arrow-back-up" label="Retouren" value="10" meta="14 %" />
        </Cells>
        <Section icon="chart-line" title="Einlieferungen je Monat">
          {place(240, "Einlieferungen je Monat", () => (
            <Chart
              kind="line"
              class="charts-v2-line"
              style={{ height: "100%" }}
              legend
              legendPlacement="top-start"
              series={
                empty()
                  ? []
                  : [
                      { label: "Eingang", data: intake.map((y, x) => ({ x, y })) },
                      { label: "Retouren", data: returns.map((y, x) => ({ x, y })) },
                    ]
              }
              xAxis={{ format: (x: number) => months[x] ?? "" }}
            />
          ))}
        </Section>
        <Section icon="chart-bar" title="Nach Lagerort">
          {place(220, "Einlieferungen nach Lagerort", () => (
            <Chart
              kind="bar"
              class="charts-v2-bar"
              style={{ height: "100%" }}
              data={
                empty()
                  ? []
                  : [
                      { label: "Halle A", value: 128 },
                      { label: "Halle B", value: 94 },
                      { label: "Außenlager", value: 41 },
                      { label: "Werkstatt", value: 18 },
                    ]
              }
            />
          ))}
        </Section>
        <Section icon="chart-donut" title="Nach Art">
          {place(200, "Einlieferungen nach Art", () => (
            <Chart
              kind="donut"
              class="charts-v2-donut"
              style={{ height: "100%" }}
              data={
                empty()
                  ? []
                  : [
                      { label: "Möbel", value: 46 },
                      { label: "Kunst", value: 28 },
                      { label: "Schmuck", value: 17 },
                      { label: "Sonstiges", value: 9 },
                    ]
              }
            />
          ))}
        </Section>
        <Section icon="filter" title="Vom Angebot zur Abrechnung">
          {place(200, "Vom Angebot zur Abrechnung", () => (
            <Chart
              kind="funnel"
              class="charts-v2-funnel"
              style={{ height: "100%" }}
              locale="de"
              data={
                empty()
                  ? []
                  : [
                      { label: "Angebote", value: 240 },
                      { label: "Eingeliefert", value: 182 },
                      { label: "Verkauft", value: 121 },
                      { label: "Abgerechnet", value: 109 },
                    ]
              }
            />
          ))}
        </Section>
        <Section icon="stairs" title="Vom Bestand zum Bestand">
          {place(220, "Bestand von Juni bis November", () => (
            <Chart
              kind="waterfall"
              class="charts-v2-waterfall"
              style={{ height: "100%" }}
              locale="de"
              start={{ label: "Juni", value: 120 }}
              steps={[
                { label: "Eingang", value: 332 },
                { label: "Verkauft", value: -241 },
                { label: "Retouren", value: 64 },
              ]}
              end={{ label: "November" }}
            />
          ))}
        </Section>
        <Section icon="calendar" title="Einlieferungen je Tag">
          {place(200, "Einlieferungen je Tag", () => (
            <Chart.Calendar class="charts-v2-calendar" style={{ height: "100%" }} locale="de" scale="sequential" data={calendarDays} />
          ))}
        </Section>
      </Pane>
    </Workspace>
  ),
  document.getElementById("root")!,
);
