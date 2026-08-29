import type { DateContext } from "@k2b/stdlib";
import { Chart, DataTable, type DataTableColumn, MarkdownView } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type {
  MetricQueryPoint,
  PulseDashboardSnapshot,
  PulsePublicDashboardEventsWidget,
  PulsePublicDashboardMapWidget,
  PulsePublicDashboardMarkdownWidget,
  PulsePublicDashboardMetricWidget,
  PulsePublicDashboardRow,
  PulsePublicDashboardSection,
  PulsePublicDashboardStatesWidget,
  PulsePublicDashboardWidget,
} from "../contracts";
import { formatDashboardConditionText, matchDashboardCondition } from "./dashboard-conditions";
import { publicDashboardEventSubject, publicDashboardStateRowId, sanitizePublicDashboardMarkdown } from "./public-dashboard-runtime";
import {
  compactDate,
  compactDateWithDelta,
  dashboardCellSpan,
  formatMetricValue,
  formatSignalValue,
  formatValue,
  gaugeMax,
  metricPointGroupLabel,
  pointsToBars,
  pointsToHeatmap,
  pointsToHistogram,
  pointsToLineSeries,
} from "./workspace/helpers";
import type { pulseMessages } from "../messages";
import { usePulseMessages } from "./use-messages";

type Props = {
  snapshot: PulseDashboardSnapshot;
  dateContext: DateContext;
};

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

const queryPointColumns = (dateContext: DateContext, t: Messages): DataTableColumn<MetricQueryPoint>[] => [
  { id: "bucket", header: t.bucket, value: (point) => compactDate(point.bucket, dateContext), cellClass: "w-32 whitespace-nowrap" },
  { id: "group", header: t.group, value: (point) => metricPointGroupLabel(point) || "-" },
  { id: "value", header: t.value, value: (point) => formatValue(point.value), cellClass: "w-32 whitespace-nowrap" },
];

const spanClasses: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7",
  8: "lg:col-span-8",
  9: "lg:col-span-9",
  10: "lg:col-span-10",
  11: "lg:col-span-11",
  12: "lg:col-span-12",
};

const metricWidgetValueFormat = (widget: PulsePublicDashboardMetricWidget) => (value: number) => formatMetricValue(value, widget.unit);

const metricWidgetLastValue = (data: MetricQueryPoint[]): number | null => data.at(-1)?.value ?? null;

const renderStatMetricVisual = (widget: PulsePublicDashboardMetricWidget, data: MetricQueryPoint[], last: number | null) => (
  <Chart
    kind="stat"
    class="h-40 text-primary"
    label={widget.title}
    value={formatMetricValue(last, widget.unit)}
    sparkline={data.map((point) => point.value ?? 0)}
  />
);

const renderGaugeMetricVisual = (widget: PulsePublicDashboardMetricWidget, last: number | null) => {
  const value = last ?? 0;
  return (
    <Chart
      kind="gauge"
      class="h-48 text-primary"
      value={value}
      min={0}
      max={gaugeMax(widget.unit ?? null, value)}
      label={widget.title}
      format={metricWidgetValueFormat(widget)}
    />
  );
};

const renderBarGaugeMetricVisual = (widget: PulsePublicDashboardMetricWidget, last: number | null) => {
  const value = last ?? 0;
  const max = gaugeMax(widget.unit ?? null, value);
  return (
    <Chart
      kind="barGauge"
      class="h-40 text-primary"
      data={[{ label: widget.title, value, min: 0, max }]}
      min={0}
      max={max}
      format={metricWidgetValueFormat(widget)}
    />
  );
};

const renderLineMetricVisual = (widget: PulsePublicDashboardMetricWidget, data: MetricQueryPoint[], dateContext: DateContext) => (
  <Chart
    kind="line"
    class="h-56 text-dimmed"
    series={pointsToLineSeries(data, widget.title)}
    xAxis={{ format: (value) => compactDate(new Date(value).toISOString(), dateContext) }}
    yAxis={{ format: metricWidgetValueFormat(widget) }}
    smooth
    area
  />
);

const renderMetricVisual = (widget: PulsePublicDashboardMetricWidget, data: MetricQueryPoint[], dateContext: DateContext, t: Messages): JSX.Element => {
  const last = metricWidgetLastValue(data);
  switch (widget.visual) {
    case "stat":
      return renderStatMetricVisual(widget, data, last);
    case "gauge":
      return renderGaugeMetricVisual(widget, last);
    case "barGauge":
      return renderBarGaugeMetricVisual(widget, last);
    case "bar":
      return <Chart kind="bar" class="h-56 text-dimmed" data={pointsToBars(data, dateContext)} showValues={data.length <= 16} />;
    case "histogram":
      return <Chart kind="histogram" class="h-56 text-dimmed" data={pointsToHistogram(data)} bins={12} yAxis={{ label: t.count }} />;
    case "heatmap":
      return (
        <Chart
          kind="heatmap"
          class="h-56 text-dimmed"
          data={pointsToHeatmap(data, dateContext)}
          format={metricWidgetValueFormat(widget)}
          showValues={data.length <= 48}
        />
      );
    case "table":
      return (
        <DataTable
          rows={data}
          columns={queryPointColumns(dateContext, t)}
          getRowId={(point) => point.bucket}
          density="compact"
          class="max-h-72 overflow-auto"
          empty={t.noPoints}
        />
      );
    default:
      return renderLineMetricVisual(widget, data, dateContext);
  }
};

export function PublicDashboardSections(props: Props) {
  const t = usePulseMessages();
  const pointsFor = (widget: PulsePublicDashboardMetricWidget): MetricQueryPoint[] => props.snapshot.points[widget.id] ?? [];

  const renderWidgetFrame = (widget: { title?: string | null; description?: string | null }, content: JSX.Element) => (
    <article class="paper h-full p-4">
      <Show when={widget.title || widget.description}>
        <div class="mb-3 min-w-0">
          <Show when={widget.title}>{(title) => <p class="truncate text-sm font-semibold text-primary">{title()}</p>}</Show>
          <Show when={widget.description}>{(description) => <p class="mt-1 text-xs leading-relaxed text-dimmed">{description()}</p>}</Show>
        </div>
      </Show>
      {content}
    </article>
  );

  const renderMetricWidgetFrame = (widget: PulsePublicDashboardMetricWidget) => {
    const condition = matchDashboardCondition(widget.conditions, pointsFor(widget).at(-1)?.value ?? null);
    const level = condition?.level ?? null;
    return (
      <article
        class="paper h-full p-4"
        classList={{
          "border-yellow-300 bg-yellow-50/70 dark:border-yellow-800 dark:bg-yellow-950/30": level === "warn",
          "border-red-300 bg-red-50/70 dark:border-red-800 dark:bg-red-950/30": level === "critical",
        }}
      >
        <div class="mb-3 min-w-0">
          <p class="truncate text-sm font-semibold text-primary">{widget.title}</p>
          <p class="mt-1 truncate text-xs text-dimmed">
            {widget.metric} · {widget.aggregation} / {widget.bucket}
          </p>
          <Show when={condition}>
            {(matched) => (
              <p
                class={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  matched().level === "critical"
                    ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200"
                    : "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-200"
                }`}
              >
                <i class={`ti ${matched().level === "critical" ? "ti-alert-triangle" : "ti-alert-circle"}`} />
                <span>{formatDashboardConditionText(matched(), t())}</span>
              </p>
            )}
          </Show>
          <Show when={widget.description}>{(description) => <p class="mt-2 text-xs leading-relaxed text-dimmed">{description()}</p>}</Show>
        </div>
        {renderMetricVisual(widget, pointsFor(widget), props.dateContext, t())}
      </article>
    );
  };

  const renderMarkdownWidget = (widget: PulsePublicDashboardMarkdownWidget) =>
    renderWidgetFrame(
      widget,
      <MarkdownView markdown={sanitizePublicDashboardMarkdown(widget.markdown)} headingScale="compact" class="text-sm" />,
    );

  const renderEventsWidget = (widget: PulsePublicDashboardEventsWidget) =>
    renderWidgetFrame(
      widget,
      <DataTable
        rows={props.snapshot.events[widget.id] ?? []}
        columns={[
          { id: "time", header: t().time, value: (event) => compactDateWithDelta(event.ts, props.dateContext) },
          { id: "event", header: t().event, value: (event) => event.kind },
          { id: "subject", header: t().subject, value: (event) => publicDashboardEventSubject(event) },
          { id: "value", header: t().value, value: (event) => formatSignalValue(event.value) },
        ]}
        getRowId={(event) => event.id}
        density="compact"
        class="max-h-80 overflow-auto"
        empty={t().noEventsMatched}
      />,
    );

  const renderStatesWidget = (widget: PulsePublicDashboardStatesWidget) => {
    const rows = props.snapshot.states[widget.id] ?? [];
    if (widget.visual === "stat") {
      const state = rows[0];
      return renderWidgetFrame(
        widget,
        <Chart
          kind="stat"
          class="h-40 text-primary"
          label={state?.key ?? widget.title}
          value={state ? formatSignalValue(state.value) : "n/a"}
          sparkline={[]}
        />,
      );
    }
    return renderWidgetFrame(
      widget,
      <DataTable
        rows={rows}
        columns={[
          { id: "state", header: t().state, value: (state) => state.key },
          { id: "value", header: t().value, value: (state) => formatSignalValue(state.value) },
          { id: "entity", header: t().entity, value: (state) => state.entityId },
          { id: "updated", header: t().updated, value: (state) => compactDateWithDelta(state.updatedAt, props.dateContext) },
        ]}
        getRowId={(state) => publicDashboardStateRowId(state)}
        density="compact"
        class="max-h-80 overflow-auto"
        empty={t().noStatesMatched}
      />,
    );
  };

  const renderMapWidget = (widget: PulsePublicDashboardMapWidget) => {
    const series = props.snapshot.maps[widget.id] ?? [];
    return renderWidgetFrame(
      widget,
      <Show
        when={series.some((item) => item.data.length)}
        fallback={<div class="flex h-64 items-center justify-center text-sm text-dimmed">{t().noMapPointsMatched}</div>}
      >
        <Chart kind="map" class="h-64 text-dimmed" series={series} legend={series.some((item) => Boolean(item.label))} interactive />
      </Show>,
    );
  };

  const renderCardWidget = (widget: PulsePublicDashboardWidget & { kind: "card" }) =>
    renderWidgetFrame(
      widget,
      <div class="space-y-3">
        <For each={widget.rows}>{(row) => renderDashboardRow(row)}</For>
      </div>,
    );

  const renderDashboardWidget = (widget: PulsePublicDashboardWidget, cellCount: number) => {
    const span = dashboardCellSpan(widget.span, cellCount);
    return (
      <div class={`col-span-1 h-full min-w-0 ${spanClasses[span] ?? spanClasses[12]}`}>
        {widget.kind === "metric"
          ? renderMetricWidgetFrame(widget)
          : widget.kind === "markdown"
            ? renderMarkdownWidget(widget)
            : widget.kind === "events"
              ? renderEventsWidget(widget)
              : widget.kind === "states"
                ? renderStatesWidget(widget)
                : widget.kind === "map"
                  ? renderMapWidget(widget)
                  : renderCardWidget(widget)}
      </div>
    );
  };

  const renderDashboardRow = (row: PulsePublicDashboardRow) => (
    <div class="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
      <For each={row.cells}>{(widget) => renderDashboardWidget(widget, row.cells.length)}</For>
    </div>
  );

  const renderDashboardSection = (section: PulsePublicDashboardSection) => (
    <section class="space-y-4">
      <div>
        <h2 class="text-base font-semibold text-primary">{section.title}</h2>
        <Show when={section.description}>
          {(description) => <p class="mt-1 max-w-3xl text-sm leading-relaxed text-dimmed">{description()}</p>}
        </Show>
      </div>
      <For each={section.rows}>{(row) => renderDashboardRow(row)}</For>
      <For each={section.sections}>{(child) => <div class="pl-3">{renderDashboardSection(child)}</div>}</For>
    </section>
  );

  return <For each={props.snapshot.dashboard.config.layout?.sections ?? []}>{(section) => renderDashboardSection(section)}</For>;
}
