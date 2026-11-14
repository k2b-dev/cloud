import { LocaleProvider as ShowcaseLocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { lineExamples } from "../../../docs-site/src/ui/demo-sections/charts/examples/line";
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
const referenceSnapshot = prepareChartSnapshot(
  {
    kind: "line",
    legendValues: true,
    legend: false,
    series: Array.from({ length: 9 }, (_, i) => ({
      label: `Series ${i}`,
      data:
        i === 1
          ? [
              { x: 1, y: 11 },
              { x: 2, y: 22 },
            ]
          : i === 8
            ? [
                { x: 1, y: 77 },
                { x: 2, y: 88 },
              ]
            : [],
    })),
  },
  { key: ({ datum }) => `${datum.seriesIndex}:${datum.index}`, tooltip: () => ({ rows: [] }) },
);
const referenceRows = referenceSnapshot.marks.map((mark) => ({ key: mark.rowKey }));
const tooltipSeries = [
  {
    data: [
      { x: 1, y: 2.5, errY: 0.5 },
      { x: 2, y: 3.5, errY: 1 },
    ],
  },
];
const [state, setState] = createSignal<ShowcaseState>("data");
const [selected, setSelected] = createSignal(false);
render(
  () => (
    <LocaleProvider locale="de">
      <main>
        <section class="time-axis-october">
          <ShowcaseLocaleProvider locale="en">
            <ShowcaseFrame
              title="Daily October balance"
              state={state()}
              height={280}
              spec={{
                kind: "line",
                title: "Daily October balance",
                series: [
                  {
                    label: "Balance",
                    data: Array.from({ length: 31 }, (_, index) => ({
                      x: `2026-10-${String(index + 1).padStart(2, "0")}`,
                      y: 15_000 + index * 200,
                    })),
                  },
                ],
                marker: { at: "2026-10-15", label: "Today" },
                legend: true,
                yAxis: { format: { style: "currency", currency: "EUR", compact: true } },
              }}
            />
          </ShowcaseLocaleProvider>
        </section>
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
        <section class="line-showcase-examples">
          <ShowcaseLocaleProvider locale="en">
            {lineExamples.map((example) => (
              <div data-line-example={example.id}>
                <ShowcaseFrame
                  spec={example.spec}
                  title={example.title}
                  state={state()}
                  height={example.height ?? 280}
                  onRetry={() => setState("data")}
                />
              </div>
            ))}
          </ShowcaseLocaleProvider>
        </section>
        <section class="reference-series line-forecast-panel">
          <ChartExplorer
            title="Reference indices"
            data={{ chart: referenceSnapshot, rows: referenceRows }}
            columns={[{ id: "row", label: "Observation", value: (row) => row.key }]}
            legend={[
              { label: "Current", color: 1, seriesIndex: 1 },
              { label: "Reference", color: 0, seriesIndex: 8 },
            ]}
            renderDetails={false}
            height="230px"
          />
        </section>
        <section class="tooltip-legacy line-forecast-panel">
          <Chart kind="line" series={tooltipSeries} labels={{ series: "Messreihe" }} style={{ height: "230px" }} />
        </section>
        <section class="tooltip-opted line-forecast-panel">
          <Chart
            kind="line"
            series={tooltipSeries}
            labels={{ series: "Messreihe" }}
            forecast={{ from: 2, band: [[2, 5]] }}
            style={{ height: "230px" }}
          />
        </section>
        <div id="line-hosts" />
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
