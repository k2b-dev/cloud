import { NumberInput, Select, TextInput } from "@k2b/ui";
import { Show } from "solid-js";
import type { CustomAppValueFormat } from "../../../custom-apps/contracts";
import { type CustomAppBuilderText, useCustomAppBuilderMessages } from "./builder-messages";

export function CustomAppValueFormatEditor(props: {
  value?: CustomAppValueFormat;
  onChange: (value: CustomAppValueFormat | undefined) => void;
}) {
  const messages = useCustomAppBuilderMessages();
  const text = (value: CustomAppBuilderText) => messages().text({ value });
  return (
    <div class="flex flex-col gap-3">
      <Select
        label={text("Value format")}
        placeholder={text("Automatic")}
        clearable
        value={() => props.value?.style ?? null}
        options={[
          { id: "number", label: text("Number") },
          { id: "integer", label: text("Integer") },
          { id: "percent", label: text("Percent") },
        ]}
        onValueChange={(style) => props.onChange(style === "number" || style === "integer" || style === "percent" ? { style } : undefined)}
      />
      <Show when={props.value && props.value.style !== "integer"}>
        <NumberInput
          label={text("Decimal places")}
          min={0}
          max={20}
          step={1}
          clearable
          value={() => props.value?.decimalPlaces ?? null}
          onValueChange={(decimalPlaces) => props.value && props.onChange({ ...props.value, decimalPlaces: decimalPlaces ?? undefined })}
        />
      </Show>
      <Show when={props.value?.style === "number"}>
        <TextInput
          label={text("Unit")}
          clearable
          value={() => props.value?.unit ?? ""}
          onValueChange={(unit) =>
            props.value?.style === "number" &&
            props.onChange({
              ...props.value,
              unit: unit || undefined,
              unitPosition: unit ? (props.value.unitPosition ?? "suffix") : undefined,
            })
          }
        />
        <Select
          label={text("Unit position")}
          value={() => props.value?.unitPosition ?? "suffix"}
          options={[
            { id: "prefix", label: text("Before value") },
            { id: "suffix", label: text("After value") },
          ]}
          onValueChange={(unitPosition) => {
            if ((unitPosition === "prefix" || unitPosition === "suffix") && props.value?.style === "number" && props.value.unit)
              props.onChange({ ...props.value, unitPosition });
          }}
        />
      </Show>
    </div>
  );
}
