import { LocaleProvider as ShowcaseLocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { liquidityForecastSpec } from "../../../docs-site/src/ui/demo-sections/charts/liquidity-forecast";
import { ShowcaseFrame, type ShowcaseState } from "../../../docs-site/src/ui/demo-sections/charts/ShowcaseFrame";
import Chart from "../src/content/Chart";
import { ChartExplorer } from "../src/content/ChartExplorer";
import { prepareChartSnapshot } from "../src/content/chart-snapshot";
import { LocaleProvider } from "../src/intl/locale";
import { lineForecastFixture } from "./line-forecast-fixture";

const snapshot = prepareChartSnapshot(
  {
    kind: "line",
    ...lineForecastFixture,
    legend: false,
    locale: "de",
    yAxis: {
      format: (value) => new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
    },
  },
  {
    key: ({ datum }) => `${datum.seriesIndex}:${datum.index}`,
    tooltip: ({ datum }) => ({
      title: String(datum.values.find((f) => f.key === "x")?.value),
      rows: [{ label: datum.label ?? "", value: datum.values.find((f) => f.key === "y")?.formatted ?? "—" }],
    }),
  },
);
const snapshotRows = snapshot.marks.map((mark) => ({
  key: mark.rowKey,
  amount: String(mark.datum.values.find((f) => f.key === "y")?.value),
}));
const [state, setState] = createSignal<ShowcaseState>("data");
const [selected, setSelected] = createSignal(false);
render(
  () => (
    <LocaleProvider locale="de">
      <main>
        <nav>
          <button type="button" onClick={() => setSelected(!selected())}>
            Select cash observation
          </button>
          {(["data", "loading", "empty", "error", "stale"] as const).map((s) => (
            <button type="button" onClick={() => setState(s)}>
              {s}
            </button>
          ))}
        </nav>
        <section class="line-forecast-panel">
          <h2>Can the studio cover its next payments?</h2>
          <p class="meta">Studio cash · January to June</p>
          <div class="line-forecast-frame">
            <Chart
              kind="line"
              selected={selected() ? { role: "point", seriesIndex: 0, index: 3 } : null}
              {...lineForecastFixture}
              yAxis={{
                format: (value) =>
                  new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
              }}
              style={{ height: "280px" }}
            />
          </div>
        </section>
        <section class="snapshot line-forecast-panel">
          <ChartExplorer
            title="Cash snapshot"
            description="Studio cash"
            request={{ status: state() === "loading" ? "loading" : state() === "error" || state() === "stale" ? "error" : "idle" }}
            asOf="09:12"
            onRetry={() => setState("data")}
            data={state() === "data" || state() === "stale" ? { chart: snapshot, rows: snapshotRows } : { rows: [] }}
            empty="Noch keine Umsätze."
            columns={[{ id: "amount", label: "Cash", value: (row) => row.amount }]}
            legend={lineForecastFixture.series.map((series, color) => ({ label: series.label, color }))}
            renderDetails={false}
            height="280px"
          />
        </section>
        <section class="line-forecast-panel early-ending">
          <Chart
            kind="line"
            legend
            legendPlacement="top-start"
            legendValues
            series={[
              {
                label: "Full",
                data: [
                  { x: 1, y: 10 },
                  { x: 2, y: 20 },
                  { x: 3, y: Number.NaN },
                ],
              },
              {
                label: "Early",
                data: [
                  { x: 1, y: 7 },
                  { x: 3, y: Number.NaN },
                ],
              },
            ]}
            style={{ height: "230px" }}
          />
        </section>
        <section class="line-forecast-panel">
          <h2>Steps at the next observation</h2>
          <Chart
            kind="line"
            {...lineForecastFixture}
            step="before"
            yAxis={{
              format: (value) =>
                new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
            }}
            style={{ height: "280px" }}
          />
        </section>
        <section class="liquidity">
          <ShowcaseLocaleProvider locale="en">
            <ShowcaseFrame spec={liquidityForecastSpec} title="Balance" state={state()} height={280} onRetry={() => setState("data")} />
          </ShowcaseLocaleProvider>
        </section>
        <div id="line-hosts" />
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
