import { DetailPanel, NumberInput, Select, TextInput } from "@k2b/ui";
import type { CustomAppBlock } from "../../../custom-apps/contracts";
import { type CustomAppBuilderText, useCustomAppBuilderMessages } from "./builder-messages";

import { CustomAppValueFormatEditor } from "./CustomAppValueFormatEditor";

type ChartBlock = Extract<CustomAppBlock, { type: "chart" }>;

export const CustomAppChartEditor = (props: { block: ChartBlock; update: (update: (block: ChartBlock) => ChartBlock) => void }) => {
  const messages = useCustomAppBuilderMessages();
  const text = (value: CustomAppBuilderText) => messages().text({ value });
  return (
    <DetailPanel.Group label={text("Chart settings")}>
      <DetailPanel.Section
        title={text("Chart")}
        icon="ti ti-chart-bar"
        description={text("Choose the chart presentation and result limit.")}
        collapsible
        defaultOpen
      >
        <div class="flex flex-col gap-4">
          <TextInput
            label={text("Subtitle")}
            value={() => props.block.subtitle ?? ""}
            onValueChange={(subtitle) => props.update((block) => ({ ...block, subtitle: subtitle || undefined }))}
            clearable
          />
          <Select
            label={text("Chart type")}
            value={() => props.block.chartType}
            options={[
              { id: "bar", label: text("Bar") },
              { id: "line", label: text("Line") },
              { id: "donut", label: text("Donut") },
            ]}
            onValueChange={(chartType) => {
              if (chartType === "bar" || chartType === "line" || chartType === "donut") props.update((block) => ({ ...block, chartType }));
            }}
          />
          <NumberInput
            label={text("Result limit")}
            value={() => props.block.limit}
            min={1}
            max={100}
            step={1}
            onValueChange={(limit) => {
              if (limit !== null) props.update((block) => ({ ...block, limit }));
            }}
          />
        </div>
      </DetailPanel.Section>
      <DetailPanel.Section
        title={text("Appearance")}
        icon="ti ti-palette"
        description={text("Optional axis labels and value formatting.")}
        collapsible
        defaultOpen={Boolean(props.block.valueFormat || props.block.xAxisLabel || props.block.yAxisLabel)}
      >
        <div class="flex flex-col gap-3">
          <TextInput
            label={text("X-axis label")}
            clearable
            value={() => props.block.xAxisLabel ?? ""}
            onValueChange={(xAxisLabel) => props.update((block) => ({ ...block, xAxisLabel: xAxisLabel || undefined }))}
          />
          <TextInput
            label={text("Y-axis label")}
            clearable
            value={() => props.block.yAxisLabel ?? ""}
            onValueChange={(yAxisLabel) => props.update((block) => ({ ...block, yAxisLabel: yAxisLabel || undefined }))}
          />
          <CustomAppValueFormatEditor
            value={props.block.valueFormat}
            onChange={(valueFormat) => props.update((block) => ({ ...block, valueFormat }))}
          />
        </div>
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
};
