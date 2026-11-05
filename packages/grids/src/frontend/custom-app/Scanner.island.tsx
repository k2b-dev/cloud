import WorkflowScannerSurface, {
  type WorkflowScannerState,
  type WorkflowScannerSurfaceTransport,
} from "../_components/workflows/WorkflowScannerSurface";

const runUrl = (endpoint: string, runId: string): string => {
  const separator = endpoint.indexOf("?");
  const path = separator === -1 ? endpoint : endpoint.slice(0, separator);
  const query = separator === -1 ? "" : endpoint.slice(separator);
  return `${path}/runs/${encodeURIComponent(runId)}${query}`;
};

export default function Scanner(props: { state: WorkflowScannerState; endpoint: string }) {
  const transport: WorkflowScannerSurfaceTransport = {
    live: false,
    invokeLauncher: ({ json }) =>
      fetch(props.endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(json),
      }),
    getRun: (runId) => fetch(runUrl(props.endpoint, runId), { headers: { Accept: "application/json" } }),
  };
  return (
    <div class="h-[min(42rem,75dvh)] min-h-[28rem] overflow-hidden rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)]">
      <WorkflowScannerSurface mode="dialog" state={props.state} transport={transport} />
    </div>
  );
}
