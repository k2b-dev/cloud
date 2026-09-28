import type { DateContext } from "@k2b/stdlib";
import { Chart, Placeholder } from "@k2b/ui";
import type { JSX } from "solid-js";
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
// Category names are drawn below the SVG, so the plot may reach almost to its
// bottom edge; the lowest value label still needs room for descenders.
const PADDING_BOTTOM = 8;
const MAX_CATEGORY_LABELS = 12;

const percent = (units: number) => `${(units / CHART_WIDTH) * 100}%`;
// Match the chart's own axis text; the global font rule would override a font utility class.
const axisFont = "var(--k2b-font-mono)";

/**
 * stdlib draws axis text at pixel size while the plot stretches, so long or
 * many category names overlap on narrower blocks, a long y-axis label runs
 * past the chart's fixed height or over the value labels, and its bar chart
 * has no x-axis label. Grids draws this text around the plot instead: each
 * category name is centred under its slot and truncated to the room it has,
 * and both axis labels are truncated to the chart, each with the full text as
 * title. Beyond MAX_CATEGORY_LABELS only every n-th category is named, with
 * the room of n.
 */
const CartesianChart = (props: {
  categories: string[];
  showAxes: boolean;
  xAxisLabel?: string;
  yAxisLabel?: string;
  children: JSX.Element;
}) => {
  const slot = (CHART_WIDTH - PADDING_RIGHT - PADDING_LEFT) / props.categories.length;
  const every = Math.ceil(props.categories.length / MAX_CATEGORY_LABELS);
  const yAxisLabel = () => (props.showAxes ? props.yAxisLabel : undefined);
  return (
    <div class="flex h-72 flex-col">
      <div class="flex min-h-0 flex-1">
        {yAxisLabel() ? (
          <p
            class="w-4 shrink-0 rotate-180 truncate text-center text-[11px] leading-4 text-dimmed"
            style={{ "writing-mode": "vertical-rl", "font-family": axisFont }}
            title={yAxisLabel()}
            data-chart-y-axis-label
          >
            {yAxisLabel()}
          </p>
        ) : null}
        {props.children}
      </div>
      {props.showAxes ? (
        // Offset by the y-axis label so percentages below match the chart's own width.
        <div class={yAxisLabel() ? "shrink-0 pl-4" : "shrink-0"}>
          <div class="relative h-4 overflow-hidden text-[10px] leading-4 text-dimmed">
            {props.categories.map((category, index) =>
              index % every === 0 ? (
                <span
                  class="absolute top-0 -translate-x-1/2 truncate px-0.5"
                  style={{
                    left: percent(PADDING_LEFT + (index + 0.5) * slot),
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
          {props.xAxisLabel ? (
            <p
              class="truncate text-center text-[11px] leading-4 text-dimmed"
              style={{ "padding-left": percent(PADDING_LEFT), "padding-right": percent(PADDING_RIGHT), "font-family": axisFont }}
              title={props.xAxisLabel}
              data-chart-x-axis-label
            >
              {props.xAxisLabel}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const yAxis = { format };
  if (renderData.kind === "donut") {
    // The box fixes the chart height; without it the SVG keeps its aspect ratio
    // and outgrows its block on wide pages.
    return (
      <div class="flex h-72 flex-col">
        <Chart kind="donut" class="min-h-0 flex-1" data={renderData.data} legend />
      </div>
    );
  }
  if (renderData.kind === "bar") {
    const categories = renderData.data.map((bar) => bar.label);
    return (
      <CartesianChart categories={categories} showAxes={categories.length > 0} xAxisLabel={props.xAxisLabel} yAxisLabel={props.yAxisLabel}>
        <Chart
          kind="bar"
          class="min-w-0 flex-1"
          data={renderData.data.map((bar) => ({ ...bar, label: "" }))}
          padding={padding}
          yAxis={yAxis}
        />
      </CartesianChart>
    );
  }
  if (renderData.kind === "line") {
    const categories = renderData.categories;
    return (
      <CartesianChart
        categories={categories}
        showAxes={renderData.series.some((series) => series.data.length > 0)}
        xAxisLabel={props.xAxisLabel}
        yAxisLabel={props.yAxisLabel}
      >
        <Chart
          kind="line"
          class="min-w-0 flex-1"
          series={renderData.series}
          padding={padding}
          // Centre each point in its category slot, as bars are, so both share the axis below.
          xAxis={{ domain: [-0.5, categories.length - 0.5], format: () => "" }}
          yAxis={yAxis}
        />
      </CartesianChart>
    );
  }
  return <Placeholder variant="compact" description={messages().noChartData} />;
}
