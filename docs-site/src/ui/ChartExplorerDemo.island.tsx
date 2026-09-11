import { DescriptionList, StatusBadge, ChartExplorer, type ChartExplorerSnapshot } from "@k2b/ui";
import type { ExplorerDemoRow } from "./chart-explorer-data";
import { DemoCard } from "./DemoCard";

export default function ChartExplorerDemo(props: {
  kind: "scatter" | "bar";
  snapshots: readonly ChartExplorerSnapshot<ExplorerDemoRow>[];
  steps: readonly { key: string; label: string }[];
  legend: readonly { key: string; label: string; color: string; marker?: "circle" | "triangle" }[];
}) {
  return (
    <DemoCard
      id={`chart-explorer-${props.kind}`}
      chip={{ kind: "component", name: "ChartExplorer", from: "@k2b/ui" }}
      description={
        props.kind === "scatter"
          ? "Synthetic demo data: explore payload and latency over the day. All SVG states are prepared on the server."
          : "Synthetic demo data: filter queues without changing their colors or the value scale."
      }
      code={
        '<ChartExplorer\n  title="Payload and latency"\n  snapshot={initialSnapshot}\n  steps={steps}\n  legend={legend}\n  load={loadServerSnapshot}\n  columns={columns}\n  getRowKey={(row) => row.key}\n/>'
      }
    >
      <ChartExplorer
        title={props.kind === "scatter" ? "Payload and latency over the day" : "Completed jobs by queue"}
        snapshot={props.snapshots[3]!}
        steps={props.steps}
        dimensionLabel="Time of day"
        legend={props.legend}
        load={async (request) => {
          const next = props.snapshots.find(
            (snapshot) =>
              snapshot.request.step === request.step &&
              snapshot.request.visibleKeys.length === request.visibleKeys.length &&
              request.visibleKeys.every((key) => snapshot.request.visibleKeys.includes(key)),
          );
          if (!next) throw new Error("Unknown demo snapshot");
          return next;
        }}
        getRowKey={(row) => row.key}
        renderDetails={(row) => (
          <DescriptionList
            columns={3}
            size="sm"
            items={[
              {
                term: "Series",
                description: (
                  <StatusBadge
                    tone="neutral"
                    icon={null}
                    label={
                      <>
                        <span style={{ color: props.legend.find((item) => item.label === row.series)?.color }} aria-hidden="true">
                          ●
                        </span>{" "}
                        {row.series}
                      </>
                    }
                  />
                ),
              },
              ...(props.kind === "scatter" ? [{ term: "Payload", description: `${row.payload} KB` }] : []),
              {
                term: props.kind === "scatter" ? "Latency" : "Completed jobs",
                description: props.kind === "scatter" ? `${row.value} ms` : String(row.value),
              },
            ]}
          />
        )}
        columns={[
          {
            id: "label",
            label: props.kind === "scatter" ? "Observation" : "Queue",
            value: (row) => row.label,
            sortValue: (row) => row.label,
          },
          ...(props.kind === "scatter"
            ? [
                {
                  id: "payload",
                  label: "Payload (KB)",
                  value: (row: ExplorerDemoRow) => `${row.payload} KB`,
                  sortValue: (row: ExplorerDemoRow) => row.payload,
                },
              ]
            : []),
          {
            id: "value",
            label: props.kind === "scatter" ? "Latency (ms)" : "Completed jobs",
            value: (row) => (props.kind === "scatter" ? `${row.value} ms` : String(row.value)),
            sortValue: (row) => row.value,
          },
        ]}
      />
    </DemoCard>
  );
}
