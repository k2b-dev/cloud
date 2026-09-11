import { Show } from "solid-js";
import { Button } from "../actions/Button";
import { Paper } from "../surfaces/Paper";
import { StatusBadge } from "../surfaces/StatusBadge";
import { useUiMessages } from "../intl/messages";
import { ChartFilterControls, type ChartFilterControlsProps } from "./ChartFilterControls";
import type { ChartExplorerController, ChartExplorerCharts } from "./chart-explorer";

export type ChartExplorerControlsProps<C extends ChartExplorerCharts> = {
  explorer: ChartExplorerController<C>;
  title: string;
  steps?: ChartFilterControlsProps["steps"];
  series?: ChartFilterControlsProps["series"];
  dimensionLabel?: string;
};

export function ChartExplorerControls<C extends ChartExplorerCharts>(props: ChartExplorerControlsProps<C>) {
  const messages = useUiMessages();
  const label = (key: string | undefined) => props.steps?.find((step) => step.key === key)?.label ?? key ?? "";
  return (
    <Paper class="k2b-chart-group-controls">
      <div class="k2b-chart-explorer__header">
        <strong>{props.title}</strong>
        <div class="k2b-chart-explorer__actions">
          <span
            class="k2b-chart-group-controls__loading"
            data-loading={props.explorer.loading() || undefined}
            role="status"
            title={
              props.explorer.loading()
                ? `${messages().loading} · ${messages().chartPreviousData}: ${label(props.explorer.snapshot().request.step)}`
                : undefined
            }
          >
            <Show when={props.explorer.loading()}>
              <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
              <span class="k2b-sr-only">
                {messages().loading} · {messages().chartPreviousData}: {label(props.explorer.snapshot().request.step)}
              </span>
            </Show>
          </span>
          <Show when={props.steps?.length && props.explorer.snapshot().request.step !== undefined}>
            <Show when={props.explorer.desired().referenceStep}>
              {(reference) => (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void props.explorer.clearReference()}
                  aria-label={`${messages().chartRemoveComparison}: ${label(reference())}`}
                >
                  {messages().chartReference}: {label(reference())} <i class="ti ti-x" aria-hidden="true" />
                </Button>
              )}
            </Show>
            <Button
              size="sm"
              variant="secondary"
              disabled={
                props.explorer.loading() ||
                props.explorer.error() !== null ||
                props.explorer.desired().referenceStep === props.explorer.snapshot().request.step
              }
              onClick={() => void props.explorer.pinReference()}
            >
              {messages().chartPinReference}
            </Button>
          </Show>
        </div>
      </div>
      <ChartFilterControls
        request={props.explorer.desired()}
        displayedRequest={props.explorer.snapshot().request}
        steps={props.steps}
        series={props.series}
        dimensionLabel={props.dimensionLabel}
        failed={props.explorer.error() !== null}
        onRequest={(request) => void props.explorer.setRequest(request)}
        onRetry={() => void props.explorer.retry()}
      />
      <Show when={props.explorer.snapshot().request.referenceStep}>
        {(reference) => (
          <div class="k2b-chart-explorer__actions" aria-live="polite">
            <StatusBadge
              tone="neutral"
              icon={null}
              label={
                <>
                  <span aria-hidden="true">●</span> {messages().chartCurrent}: {label(props.explorer.snapshot().request.step)}
                </>
              }
            />
            <StatusBadge
              tone="neutral"
              icon={null}
              label={
                <>
                  <span aria-hidden="true">○</span> {messages().chartReference}: {label(reference())}
                </>
              }
            />
          </div>
        )}
      </Show>
    </Paper>
  );
}
