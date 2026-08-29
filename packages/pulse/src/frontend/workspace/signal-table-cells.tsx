import type { DataTableColumn } from "@k2b/ui";
import { Show, type Accessor, type JSX } from "solid-js";
import type { PulseCurrentState, PulseMetricSeries, PulseRecordedEvent } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import {
  compactDateWithDelta,
  dimensionsSummary,
  formatMetricValue,
  formatSignalValue,
  formatValue,
  signalSubject,
  type PulseDateContext,
} from "./helpers";

type TableCellRenderer<Row> = (row: Row, col: DataTableColumn<Row>, render: (value: unknown) => JSX.Element) => JSX.Element;

type SignalTableCellRenderers = {
  renderEventCell: TableCellRenderer<PulseRecordedEvent>;
  renderStateCell: TableCellRenderer<PulseCurrentState>;
  renderMetricSeriesCell: TableCellRenderer<PulseMetricSeries>;
};

type SignalTableCellRendererOptions = {
  sourceNameById: Accessor<Map<string, string>>;
  dateContext: Accessor<PulseDateContext>;
  metricUnit: Accessor<string | null | undefined>;
  openSource: (sourceId: string | null | undefined) => void;
};

const dimensionsTitle = (dimensions: Record<string, string>) =>
  Object.entries(dimensions)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

export const createSignalTableCellRenderers = (options: SignalTableCellRendererOptions): SignalTableCellRenderers => {
  const t = usePulseMessages();
  const renderSourceLink = (sourceId: string | null | undefined) => {
    if (!sourceId) return <span class="text-xs text-dimmed">-</span>;
    return (
      <button
        type="button"
        class="inline-flex max-w-full items-center gap-1 truncate text-xs font-medium text-secondary transition hover:app-accent-text"
        onClick={(event) => {
          event.stopPropagation();
          options.openSource(sourceId);
        }}
        title={t().openSource}
      >
        <i class="ti ti-database-share shrink-0" />
        <span class="truncate">{options.sourceNameById().get(sourceId) ?? t().unknownSource}</span>
      </button>
    );
  };

  const renderEventCell: TableCellRenderer<PulseRecordedEvent> = (event, col, render) => {
    if (col.id === "subject") {
      const summary = dimensionsSummary(event.dimensions);
      return (
        <div class="min-w-0">
          <p class="truncate text-xs font-medium text-secondary">{signalSubject(event)}</p>
          <Show when={summary}>{(text) => <p class="mt-0.5 truncate text-[11px] text-dimmed">{text()}</p>}</Show>
        </div>
      );
    }
    if (col.id === "source") return renderSourceLink(event.sourceId);
    if (col.id === "dimensions") {
      const summary = dimensionsSummary(event.dimensions, 6);
      return (
        <span class="line-clamp-2 text-xs text-secondary" title={dimensionsTitle(event.dimensions)}>
          {summary || "-"}
        </span>
      );
    }
    if (col.id === "value") return <span class="text-xs text-secondary">{event.value === null ? "-" : formatValue(event.value)}</span>;
    if (col.id === "time") return <span class="text-xs text-secondary">{compactDateWithDelta(event.ts, options.dateContext())}</span>;
    return render(event[col.id as keyof PulseRecordedEvent]);
  };

  const renderStateCell: TableCellRenderer<PulseCurrentState> = (state, col, render) => {
    if (col.id === "value") {
      return (
        <span class="line-clamp-2 text-xs text-secondary" title={formatSignalValue(state.value)}>
          {formatSignalValue(state.value)}
        </span>
      );
    }
    if (col.id === "subject") {
      const summary = dimensionsSummary(state.dimensions);
      return (
        <div class="min-w-0">
          <p class="truncate text-xs font-medium text-secondary">{signalSubject(state)}</p>
          <Show when={summary}>{(text) => <p class="mt-0.5 truncate text-[11px] text-dimmed">{text()}</p>}</Show>
        </div>
      );
    }
    if (col.id === "source") return renderSourceLink(state.sourceId);
    if (col.id === "dimensions") {
      const summary = dimensionsSummary(state.dimensions, 6);
      return (
        <span class="line-clamp-2 text-xs text-secondary" title={dimensionsTitle(state.dimensions)}>
          {summary || "-"}
        </span>
      );
    }
    if (col.id === "updated")
      return <span class="text-xs text-secondary">{compactDateWithDelta(state.updatedAt, options.dateContext())}</span>;
    return render(state[col.id as keyof PulseCurrentState]);
  };

  const renderMetricSeriesCell: TableCellRenderer<PulseMetricSeries> = (item, col, render) => {
    if (col.id === "subject") {
      return <span class="truncate text-xs font-medium text-secondary">{signalSubject(item)}</span>;
    }
    if (col.id === "current") {
      const unit = options.metricUnit();
      return (
        <span class="text-xs font-medium text-primary">{item.latestValue === null ? "-" : formatMetricValue(item.latestValue, unit)}</span>
      );
    }
    if (col.id === "source") return renderSourceLink(item.sourceId);
    if (col.id === "dimensions") {
      const summary = dimensionsSummary(item.dimensions, 6);
      return (
        <span class="line-clamp-2 text-xs text-secondary" title={dimensionsTitle(item.dimensions)}>
          {summary || "-"}
        </span>
      );
    }
    if (col.id === "lastSeen")
      return (
        <span class="text-xs text-secondary">{item.lastSeenAt ? compactDateWithDelta(item.lastSeenAt, options.dateContext()) : "-"}</span>
      );
    return render(item[col.id as keyof PulseMetricSeries]);
  };

  return { renderEventCell, renderStateCell, renderMetricSeriesCell };
};
