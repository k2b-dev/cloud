import { For, Show, createSignal, onMount, onCleanup } from "solid-js";
import {
  Button,
  ChartExplorer,
  ChartExplorerControls,
  createChartExplorer,
  DescriptionList,
  Paper,
  StatusBadge,
  type ChartExplorerSnapshot,
} from "@k2b/ui";
import { comparisonValues, signed, type LinkedChartRow } from "./chart-group-demo-model";
import type { LinkedCharts } from "./chart-group-data";
import { chartRequestFromSearch, chartSearchParams } from "./chart-group-url";
import { DemoCard } from "./DemoCard";

export default function ChartGroupDemo(props: {
  snapshot: ChartExplorerSnapshot<LinkedCharts>;
  steps: { key: string; label: string }[];
  legend: { key: string; label: string; color: string }[];
}) {
  const chartIds = ["latency", "requests"] as const;
  const [request, setRequest] = createSignal(props.snapshot.request);
  onMount(() => {
    const restore = () => setRequest(chartRequestFromSearch(window.location.search));
    window.addEventListener("popstate", restore);
    onCleanup(() => window.removeEventListener("popstate", restore));
  });
  const group = createChartExplorer({
    snapshot: () => props.snapshot,
    request,
    onRequestChange: (next) => {
      setRequest(next);
      const url = new URL(window.location.href);
      url.search = chartSearchParams(next, url.searchParams).toString();
      window.history.pushState(null, "", url);
    },
    load: async (request, signal) => {
      const query = new URLSearchParams({ step: request.step ?? "08" });
      if (request.referenceStep !== undefined) query.set("reference", request.referenceStep);
      request.visibleKeys?.forEach((key) => query.append("series", key));
      const response = await fetch(`/api/ui/chart-exploration?${query}`, {
        signal,
      });
      if (!response.ok) throw new Error("Could not load chart group");
      const value: ChartExplorerSnapshot<LinkedCharts> = await response.json();
      return value;
    },
  });
  const selected = () =>
    Object.values(group.snapshot().charts)
      .flatMap((chart) => chart.rows)
      .find((row) => row.key === group.selectedKey());
  return (
    <DemoCard
      id="chart-group"
      chip={{ kind: "component", name: "ChartExplorer", from: "@k2b/ui" }}
      description="SSR and URL state: both charts describe the same request groups. The server renders every snapshot; the URL preserves filters and reference time across reload and browser history. Selecting a group highlights its current and reference marks in both charts."
      code={
        'const group = createChartExplorer({ snapshot: () => initial, load });\n<ChartExplorerControls explorer={group} title="Request analysis" steps={steps} series={series} />\n<ChartExplorer renderDetails={false} data={group.snapshot().charts.latency} selectedKey={group.selectedKey()} onSelectedKeyChange={group.select} /* columns, title */ />'
      }
    >
      <ChartExplorerControls
        explorer={group}
        title="Request analysis"
        steps={props.steps}
        series={props.legend}
        dimensionLabel="Time of day"
      />
      <div class="ui-demo-chart-group-grid" aria-busy={group.loading()}>
        <For each={chartIds}>
          {(id) => {
            const unit = id === "latency" ? " ms" : "";
            const format = (value: number | null) => (value === null ? "Not available" : `${value}${unit}`);
            const referenceText = (row: LinkedChartRow) => {
              const difference = comparisonValues(row.current, row.reference);
              const change =
                difference.percent !== null
                  ? `${signed(difference.percent)}%`
                  : difference.delta !== null
                    ? `${signed(difference.delta)}${unit} · % unavailable`
                    : "No comparison";
              return `Ref ${group.snapshot().request.referenceStep}:00: ${format(row.reference)} · ${change}`;
            };
            return (
              <ChartExplorer<LinkedChartRow>
                title={id === "latency" ? "Latency by payload" : "Requests by payload (KB)"}
                data={group.snapshot().charts[id]}
                selectedKey={group.selectedKey()}
                onSelectedKeyChange={group.select}
                columns={[
                  {
                    id: "observation",
                    label: "Observation",
                    value: (row) => `${row.series} · ${row.payload} KB`,
                    sortValue: (row) => row.key,
                  },
                  {
                    id: "value",
                    label: id === "latency" ? "Latency (ms)" : "Requests",
                    value: (row) =>
                      `${format(row.current)}${group.snapshot().request.referenceStep === undefined ? "" : `\n${referenceText(row)}`}`,
                    sortValue: (row) => row.current,
                    render: (row) => (
                      <div class="ui-demo-chart-group-cell">
                        <span>{format(row.current)}</span>
                        <Show when={group.snapshot().request.referenceStep !== undefined}>
                          <small>{referenceText(row)}</small>
                        </Show>
                      </div>
                    ),
                  },
                ]}
                renderDetails={false}
              />
            );
          }}
        </For>
      </div>
      <Show when={selected()}>
        {(row) => (
          <Paper as="section" class="ui-demo-chart-group-details" aria-label="Selected request group">
            <div class="ui-demo-chart-group-selection">
              <strong>Selected request group</strong>
              <StatusBadge tone="neutral" icon={null} label={`${row().series} · ${row().payload} KB`} />
              <Button
                size="sm"
                variant="text"
                disabled={
                  group.loading() ||
                  group.error() !== null ||
                  (group.desired().visibleKeys?.length === 1 && group.desired().visibleKeys?.[0] === row().seriesKey)
                }
                onClick={() => void group.setRequest({ ...group.desired(), step: group.desired().step, visibleKeys: [row().seriesKey] })}
              >
                Filter to {row().series}
              </Button>
              <Button size="sm" variant="text" onClick={() => group.select(null)}>
                Clear selection
              </Button>
            </div>
            <div class="ui-demo-chart-group-metrics" aria-live="polite">
              <For each={chartIds}>
                {(id) => {
                  const metric = () => group.snapshot().charts[id].rows.find((item) => item.key === row().key);
                  const current = () => metric()?.current ?? null;
                  const reference = () => metric()?.reference ?? null;
                  const difference = () => comparisonValues(current(), reference());
                  const unit = id === "latency" ? " ms" : "";
                  const format = (value: number | null) => (value === null ? "Not available" : `${value}${unit}`);
                  return (
                    <section>
                      <strong>{id === "latency" ? "Latency" : "Requests"}</strong>
                      <DescriptionList
                        columns={2}
                        size="sm"
                        items={[
                          {
                            term: `Current ${group.snapshot().request.step}:00`,
                            description: format(current()),
                          },
                          ...(group.snapshot().request.referenceStep === undefined
                            ? []
                            : [
                                {
                                  term: `Reference ${group.snapshot().request.referenceStep}:00`,
                                  description: format(reference()),
                                },
                                {
                                  term: "Change",
                                  description: difference().delta === null ? "No comparison" : `${signed(difference().delta!)}${unit}`,
                                },
                                {
                                  term: "Change (%)",
                                  description: difference().percent === null ? "Not available" : `${signed(difference().percent!)}%`,
                                },
                              ]),
                        ]}
                      />
                    </section>
                  );
                }}
              </For>
            </div>
          </Paper>
        )}
      </Show>
    </DemoCard>
  );
}
