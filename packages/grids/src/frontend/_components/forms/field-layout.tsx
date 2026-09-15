import { Select, useLocale } from "@k2b/ui";
import { gridsFormMessages } from "./messages";

export type FormFieldWidth = "fullWidth" | "compact";

// Flex wrapping preserves authored/keyboard order. Full-width items start a
// new row; compact items share available space without a layout DSL.
export const formLayoutClass = "flex min-w-0 flex-wrap items-start gap-3";
export const formFieldClass = (width?: FormFieldWidth) => (width === "compact" ? "min-w-0 flex-[1_1_10rem]" : "min-w-0 basis-full");

export function FormFieldWidthSelect(props: { value?: FormFieldWidth; onChange: (width: FormFieldWidth) => void }) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  return (
    <Select
      label={t().fieldWidth}
      value={() => props.value ?? "fullWidth"}
      options={[
        { id: "fullWidth", label: t().fullWidth },
        { id: "compact", label: t().compact },
      ]}
      onValueChange={(value) => {
        if (value === "fullWidth" || value === "compact") props.onChange(value);
      }}
    />
  );
}
