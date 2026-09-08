import { Select } from "@k2b/ui";
import type { PublicField } from "../../../api/public-dto";
import type { CustomAppBlock } from "../../../custom-apps/contracts";
import { type CustomAppBuilderText, useCustomAppBuilderMessages } from "./builder-messages";

type HtmlBlock = Extract<CustomAppBlock, { type: "html" }>;

export const CustomAppHtmlEditor = (props: {
  block: HtmlBlock;
  fields: readonly PublicField[];
  error?: string;
  update: (update: (block: HtmlBlock) => HtmlBlock) => void;
}) => {
  const messages = useCustomAppBuilderMessages();
  const text = (value: CustomAppBuilderText) => messages().text({ value });
  return (
    <>
      <Select
        label={text("HTML template field")}
        searchable
        value={() => props.block.fieldId}
        options={props.fields.map((field) => ({
          id: field.id,
          label: field.name,
          description: text("HTML template"),
          icon: field.icon ?? "ti ti-code",
        }))}
        error={() => props.error}
        onValueChange={(fieldId) => {
          if (fieldId) props.update((block) => ({ ...block, fieldId }));
        }}
      />
      <Select
        label={text("Height")}
        value={() => props.block.height}
        options={[
          { id: "compact", label: text("Compact") },
          { id: "normal", label: text("Normal") },
          { id: "large", label: text("Large") },
        ]}
        onValueChange={(height) => {
          if (height === "compact" || height === "normal" || height === "large") props.update((block) => ({ ...block, height }));
        }}
      />
    </>
  );
};
