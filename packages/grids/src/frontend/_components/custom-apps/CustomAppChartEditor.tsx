import { DetailPanel, NumberInput, Select, TextInput } from "@k2b/ui";
import { Show } from "solid-js";
import type { CustomAppBlock } from "../../../custom-apps/contracts";
import { type CustomAppBuilderText, useCustomAppBuilderMessages } from "./builder-messages";

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
          <Select
            label={text("Value format")}
            placeholder={text("Automatic")}
            clearable
            value={() => props.block.valueFormat?.style ?? null}
            options={[
              { id: "number", label: text("Number") },
              { id: "integer", label: text("Integer") },
              { id: "percent", label: text("Percent") },
            ]}
            onValueChange={(style) =>
              props.update((block) => ({
                ...block,
                valueFormat: style === "number" || style === "integer" || style === "percent" ? { style } : undefined,
              }))
            }
          />
          <Show when={props.block.valueFormat && props.block.valueFormat.style !== "integer"}>
            <NumberInput
              label={text("Decimal places")}
              min={0}
              max={20}
              step={1}
              clearable
              value={() => props.block.valueFormat?.decimalPlaces ?? null}
              onValueChange={(decimalPlaces) =>
                props.update((block) =>
                  block.valueFormat
                    ? { ...block, valueFormat: { ...block.valueFormat, decimalPlaces: decimalPlaces ?? undefined } }
                    : block,
                )
              }
            />
          </Show>
          <Show when={props.block.valueFormat?.style === "number"}>
            <TextInput
              label={text("Unit")}
              clearable
              value={() => props.block.valueFormat?.unit ?? ""}
              onValueChange={(unit) =>
                props.update((block) =>
                  block.valueFormat?.style === "number"
                    ? {
                        ...block,
                        valueFormat: {
                          ...block.valueFormat,
                          unit: unit || undefined,
                          unitPosition: unit ? (block.valueFormat.unitPosition ?? "suffix") : undefined,
                        },
                      }
                    : block,
                )
              }
            />
            <Select
              label={text("Unit position")}
              value={() => props.block.valueFormat?.unitPosition ?? "suffix"}
              options={[
                { id: "prefix", label: text("Before value") },
                { id: "suffix", label: text("After value") },
              ]}
              onValueChange={(unitPosition) => {
                if (unitPosition === "prefix" || unitPosition === "suffix")
                  props.update((block) =>
                    block.valueFormat?.style === "number" && block.valueFormat.unit
                      ? { ...block, valueFormat: { ...block.valueFormat, unitPosition } }
                      : block,
                  );
              }}
            />
          </Show>
        </div>
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
};
