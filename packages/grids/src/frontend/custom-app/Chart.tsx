import type { DateContext } from "@k2b/stdlib";
import { Chart, Placeholder } from "@k2b/ui";
import type { CustomAppValueFormat } from "../../custom-apps/contracts";
import type { CustomAppChartData } from "../../service/custom-app-insights";
import { buildChartRenderData } from "./chart-data";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import { formatCustomAppValue } from "./value-format";

type ChartType = "bar" | "line" | "donut";

// @k2b/ui draws every chart in a 480-unit wide space and stretches it to the box.
const CHART_WIDTH = 480;
// The default gutter fits plain numbers; our labels also include decimal places and units.
const PADDING_LEFT = 96;
const PADDING_RIGHT = 16;
// stdlib widens the left gutter by this much when it draws a y-axis label.
const Y_AXIS_LABEL_GUTTER = 14;
// Category names are drawn below the SVG, so the plot may reach its bottom edge.
const PADDING_BOTTOM = 4;
const MAX_CATEGORY_LABELS = 12;

const percent = (units: number) => `${(units / CHART_WIDTH) * 100}%`;
// Match the chart's own axis text; the global font rule would override a font utility class.
const axisFont = "var(--k2b-font-mono)";

/**
 * stdlib draws category names at full length in pixel-sized text while the
 * plot stretches, so long or many names overlap on narrower blocks, and its
 * bar chart has no x-axis label. Each name is centred under its category slot
 * here and truncated to the room it has, with the full name as title; beyond
 * MAX_CATEGORY_LABELS only every n-th category is named, with the room of n.
 */
const CategoryAxis = (props: { categories: string[]; plotStart: number; label?: string }) => {
  const slot = (CHART_WIDTH - PADDING_RIGHT - props.plotStart) / props.categories.length;
  const every = Math.ceil(props.categories.length / MAX_CATEGORY_LABELS);
  return (
    <>
      <div class="relative h-4 shrink-0 overflow-hidden text-[10px] leading-4 text-dimmed">
        {props.categories.map((category, index) =>
          index % every === 0 ? (
            <span
              class="absolute top-0 -translate-x-1/2 truncate px-0.5"
              style={{
                left: percent(props.plotStart + (index + 0.5) * slot),
                "max-width": percent(every * slot),
                "font-family": axisFont,
              }}
              title={category}
              data-chart-category
            >
              {category}
            </span>
          ) : null,
        )}
      </div>
      {props.label ? (
        <p
          class="shrink-0 truncate text-center text-[11px] leading-4 text-dimmed"
          style={{ "padding-left": percent(props.plotStart), "padding-right": percent(PADDING_RIGHT), "font-family": axisFont }}
          title={props.label}
          data-chart-x-axis-label
        >
          {props.label}
        </p>
      ) : null}
    </>
  );
};

export default function CustomAppChart(props: {
  chartType: ChartType;
  data: CustomAppChartData;
  valueFormat?: CustomAppValueFormat;
  dateConfig: DateContext;
  xAxisLabel?: string;
  yAxisLabel?: string;
}) {
  const messages = useCustomAppRuntimeMessages();
  if (props.data.kind === "error") {
    return <Placeholder variant="compact" description={messages().chartDataUnavailable} />;
  }

  const renderData = buildChartRenderData({
    widget: { chartType: props.chartType },
    groupBy: props.data.viewQuery.groupBy,
    aggregations: props.data.viewQuery.aggregations,
    buckets: props.data.buckets,
    fieldsById: new Map(props.data.fields.map((field) => [field.id, field])),
    relationLabels: props.data.relationLabels,
    categoryFormat: { locale: props.dateConfig.locale, unknownRecordLabel: messages().unknownRecord },
  });
  const format = (value: number) => formatCustomAppValue(value, props.valueFormat, props.dateConfig);
  const padding = { left: PADDING_LEFT, right: PADDING_RIGHT, bottom: PADDING_BOTTOM };
  const yAxis = { format, label: props.yAxisLabel };
  const plotStart = PADDING_LEFT + (props.yAxisLabel ? Y_AXIS_LABEL_GUTTER : 0);
  // The box fixes the chart height; without it the SVG keeps its aspect ratio
  // and outgrows its block on wide pages.
  const chartClass = "min-h-0 flex-1";
  if (renderData.kind === "donut") {
    return (
      <div class="flex h-72 flex-col">
        <Chart kind="donut" class={chartClass} data={renderData.data} legend />
      </div>
    );
  }
  if (renderData.kind === "bar") {
    const categories = renderData.data.map((bar) => bar.label);
    return (
      <div class="flex h-72 flex-col">
        <Chart kind="bar" class={chartClass} data={renderData.data.map((bar) => ({ ...bar, label: "" }))} padding={padding} yAxis={yAxis} />
        {categories.length > 0 ? <CategoryAxis categories={categories} plotStart={plotStart} label={props.xAxisLabel} /> : null}
      </div>
    );
  }
  if (renderData.kind === "line") {
    const categories = renderData.categories;
    const hasPoints = renderData.series.some((series) => series.data.length > 0);
    return (
      <div class="flex h-72 flex-col">
        <Chart
          kind="line"
          class={chartClass}
          series={renderData.series}
          padding={padding}
          // Centre each point in its category slot, as bars are, so both share the axis below.
          xAxis={{ domain: [-0.5, categories.length - 0.5], format: () => "" }}
          yAxis={yAxis}
        />
        {hasPoints ? <CategoryAxis categories={categories} plotStart={plotStart} label={props.xAxisLabel} /> : null}
      </div>
    );
  }
  return <Placeholder variant="compact" description={messages().noChartData} />;
}
