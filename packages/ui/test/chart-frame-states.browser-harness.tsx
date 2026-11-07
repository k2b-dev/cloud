import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { ChartExplorer, type ChartFrameRequest } from "../src/content/ChartExplorer";

type Row = { key: string; label: string; value: number };
const rows: Row[] = [
  { key: "jan", label: "January", value: 42 },
  { key: "feb", label: "February", value: 28 },
  { key: "mar", label: "March", value: 35 },
  { key: "apr", label: "April", value: 51 },
];
const states: Record<string, { rows: Row[]; request: ChartFrameRequest }> = {
  data: { rows, request: { status: "idle" } },
  loading: { rows: [], request: { status: "loading" } },
  empty: { rows: [], request: { status: "idle" } },
  error: { rows: [], request: { status: "error" } },
  stale: { rows, request: { status: "error" } },
};
const [state, setState] = createSignal("data");
const [view, setView] = createSignal<"chart" | "table">("chart");
Object.assign(window, { setFrameState: setState, setFrameView: setView });

render(
  () => (
    <main style={{ padding: "16px" }}>
      <div class="frame" style={{ padding: "16px", border: "1px solid #e4e4e7", "border-radius": "8px", overflow: "hidden" }}>
        <ChartExplorer<Row>
          title="Signups per month"
          description="All sources · invented data"
          height="240px"
          inset="16px"
          renderDetails={false}
          view={view()}
          onViewChange={setView}
          request={states[state()]!.request}
          asOf="09:12"
          empty="No signups in this period."
          onRetry={() => setState("data")}
          data={{ rows: states[state()]!.rows }}
          columns={[
            { id: "label", label: "Month", value: (row) => row.label, sortValue: (row) => rows.indexOf(row) },
            { id: "value", label: "Signups", value: (row) => String(row.value), sortValue: (row) => row.value, align: "right" },
          ]}
        >
          <Chart kind="bar" class="frame-bar" style={{ height: "100%" }} data={rows.map(({ label, value }) => ({ label, value }))} />
        </ChartExplorer>
      </div>
      <Chart
        kind="bar"
        class="rows-bar"
        style={{ height: "220px", width: "360px" }}
        data={[
          { label: "Northwestern coastal region", value: 184 },
          { label: "Southern lake district", value: 142 },
          { label: "Eastern uplands", value: 97 },
        ]}
      />
      <Chart kind="histogram" class="overlay-histogram" style={{ height: "160px", width: "360px" }} data={[1, 2, 3, 4, 5]} bins={3} />
      <Chart kind="sparkline" class="trend-spark" style={{ height: "30px", width: "160px" }} data={[3, 5, 4, 8, 9]} />
    </main>
  ),
  document.getElementById("root")!,
);
