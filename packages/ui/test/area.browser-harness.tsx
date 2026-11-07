import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { ChartExplorer } from "../src/content/ChartExplorer";
import { prepareChartSnapshot } from "../src/content/chart-snapshot";
import { LocaleProvider } from "../src/intl/locale";
import { areaFixture } from "./area-fixture";

const snapshotOptions = { kind: "area" as const, ...areaFixture, legend: false, locale: "de" };
const snapshot = prepareChartSnapshot(snapshotOptions, {
  key: ({ datum }) => `${datum.seriesIndex}:${datum.index}`,
  tooltip: ({ datum }) => ({
    title: String(datum.values.find((f) => f.key === "x")?.value),
    rows: [
      {
        label: datum.label ?? "",
        value: datum.values
          .filter((f) => f.key !== "x")
          .map((f) => f.formatted ?? String(f.value))
          .join(" · "),
      },
    ],
  }),
});
const snapshotRows = snapshot.marks.map((mark) => ({
  key: mark.rowKey,
  amount: String(mark.datum.values.find((field) => field.key === "value")?.value),
}));
const [state, setState] = createSignal("data");
render(
  () => (
    <LocaleProvider locale="de">
      <main>
        <nav>
          {["data", "loading", "empty", "error", "stale"].map((s) => (
            <button type="button" onClick={() => setState(s)}>
              {s}
            </button>
          ))}
        </nav>
        <section class="area-panel">
          <h2>How the sales mix changes</h2>
          <p class="meta">Studio sales · January to June</p>
          <div class="area-frame">
            <Chart kind="area" {...areaFixture} style={{ height: "280px" }} />
          </div>
        </section>
        <section class="area-panel">
          <h2>Absolute sales</h2>
          <Chart kind="area" {...areaFixture} normalize={false} style={{ height: "280px" }} />
        </section>
        <section class="snapshot area-panel">
          <ChartExplorer
            title="Sales snapshot"
            description={state() === "stale" ? "Veraltet · Studio sales" : "Studio sales"}
            data={{ chart: snapshot, rows: state() === "data" || state() === "stale" ? snapshotRows : [] }}
            empty={
              state() === "loading" ? (
                <p role="status">Daten werden geladen.</p>
              ) : state() === "error" ? (
                <div role="alert">
                  Daten konnten nicht geladen werden.
                  <button type="button" onClick={() => setState("data")}>
                    Erneut versuchen
                  </button>
                </div>
              ) : (
                <p>Noch keine Umsätze.</p>
              )
            }
            columns={[{ id: "amount", label: "Sales", value: (row) => row.amount }]}
            legend={areaFixture.series.map((s, color) => ({ label: s.label, color }))}
            renderDetails={false}
            height="280px"
          />
        </section>
        <section class="line-regression">
          <Chart
            kind="line"
            legend
            legendPlacement="top-start"
            style={{ height: "160px" }}
            series={[
              {
                label: "Requests",
                data: [
                  { x: 1, y: 2 },
                  { x: 2, y: 3 },
                ],
              },
            ]}
          />
        </section>
        <section class="absolute-zero">
          <Chart kind="area" layout="stacked" x={[2023]} series={[{ label: "Zero", data: [0] }]} style={{ height: "160px" }} />
        </section>
        <section class="many">
          <Chart
            kind="area"
            layout="stacked"
            x={[1, 2]}
            series={Array.from({ length: 40 }, (_, i) => ({ label: `Complete revenue source ${i + 1}`, data: [1, 2] }))}
            style={{ height: "180px" }}
          />
        </section>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
