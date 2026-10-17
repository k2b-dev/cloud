import type { DateContext } from "@k2b/stdlib";
import type { ChartTooltipFormatter } from "@k2b/ui";
import type { CustomAppValueFormat } from "../../custom-apps/contracts";
import type { ChartRenderData } from "./chart-data";
import { formatCustomAppValue } from "./value-format";

export const customAppChartTooltip =
  (options: {
    chart: ChartRenderData;
    valueFormat?: CustomAppValueFormat;
    dateConfig: Pick<DateContext, "locale">;
    shareLabel: string;
  }): ChartTooltipFormatter =>
  ({ datum }) => {
    const number = (key: string) => {
      const value = datum.values.find((value) => value.key === key)?.value;
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };
    const format = (value: number | undefined) => formatCustomAppValue(value, options.valueFormat, options.dateConfig);
    const chart = options.chart;
    switch (chart.kind) {
      case "bar":
        return { title: chart.data[datum.index]?.label, rows: [{ label: chart.valueLabel, value: format(number("value")) }] };
      case "donut": {
        const percent = number("percent");
        return {
          title: chart.data[datum.index]?.label,
          rows: [
            { label: chart.valueLabel, value: format(number("value")) },
            ...(percent === undefined
              ? []
              : [
                  {
                    label: options.shareLabel,
                    value: new Intl.NumberFormat(options.dateConfig.locale ?? "en", { style: "percent", maximumFractionDigits: 1 }).format(
                      percent / 100,
                    ),
                  },
                ]),
          ],
        };
      }
      case "line": {
        const x = number("x");
        return {
          title: x !== undefined && Number.isInteger(x) && x >= 0 && x < chart.categories.length ? chart.categories[x] : undefined,
          rows: [{ label: datum.label ?? "", value: format(number("y")) }],
        };
      }
    }
  };
