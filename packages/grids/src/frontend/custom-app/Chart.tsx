import type { DateContext } from "@k2b/stdlib";
import { Chart, Placeholder } from "@k2b/ui";
import type { CustomAppValueFormat } from "../../custom-apps/contracts";
import type { CustomAppChartData } from "../../service/custom-app-insights";
import { buildChartRenderData } from "./chart-data";
import { useCustomAppRuntimeMessages } from "./runtime-messages";
import { formatCustomAppValue } from "./value-format";

type ChartType = "bar" | "line" | "donut";

export default function CustomAppChart(props: {
  chartType: ChartType;
  data: CustomAppChartData;
  valueFormat?: CustomAppValueFormat;
  dateConfig: DateContext;
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
  if (renderData.kind === "donut") return <Chart kind="donut" data={renderData.data} legend />;
  if (renderData.kind === "bar") return <Chart kind="bar" data={renderData.data} yAxis={{ format }} />;
  if (renderData.kind === "line") {
    return <Chart kind="line" series={renderData.series} xAxis={{ format: renderData.xAxisFormat }} yAxis={{ format }} />;
  }
  return <Placeholder variant="compact" description={messages().noChartData} />;
}
