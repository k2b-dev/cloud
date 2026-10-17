import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { LocaleProvider } from "../src/intl/locale";
import { StatCell } from "../src/surfaces/StatCell";

const latencyTrend = [12, 18];

render(
  () => (
    <main style={{ width: "100%", "max-width": "480px" }}>
      <button type="button" id="before">
        Before chart
      </button>
      <Chart
        kind="bar"
        class="plain-bar"
        style={{ height: "240px" }}
        data={[
          { label: "Imports", value: 42 },
          { label: "Exports", value: 28 },
          { label: "Retries", value: 7 },
        ]}
      />
      <button type="button" id="after">
        After chart
      </button>
      <Chart
        kind="line"
        class="plain-line"
        style={{ height: "120px" }}
        series={[
          {
            label: "Latency",
            data: [
              { x: 1, y: 12 },
              { x: 2, y: 24 },
            ],
          },
        ]}
      />
      <div class="requests-trend">
        <StatCell label="Requests" value={42} trend={[12, 24, 18]} />
      </div>
      <div class="de-trend">
        <LocaleProvider locale="de">
          <StatCell label="Umsatz" value={1500} trend={[1200, 1500]} />
        </LocaleProvider>
      </div>
      <div class="custom-trend">
        <StatCell
          label="Latency"
          value={18}
          trend={latencyTrend}
          trendTooltip={({ datum }) => ({
            title: `Day ${datum.index + 1}`,
            rows: [{ label: "Latency", value: `${latencyTrend[datum.index]} ms` }],
          })}
        />
      </div>
      <div aria-hidden="true" style={{ height: "1600px" }} />
    </main>
  ),
  document.getElementById("root")!,
);
