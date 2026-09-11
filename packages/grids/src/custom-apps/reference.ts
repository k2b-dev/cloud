import { z } from "zod";
import { CUSTOM_APP_REFERENCE, CustomAppDefinitionSchema } from "./contracts";

// Keep schema conversion on the server, outside the builder's contract module.
export const CUSTOM_APP_API_REFERENCE = {
  ...CUSTOM_APP_REFERENCE,
  definitionSchema: z.toJSONSchema(CustomAppDefinitionSchema, { io: "input" }),
  validation: {
    schema: "definitionSchema describes accepted input, including optional properties, enums, defaults and size limits.",
    semantics:
      "JSON Schema cannot express all cross-field and permission checks. Run apps validate against the target Base before apply or publish.",
    checks: [
      "Local IDs are unique in their scope: pages per App, rows and blocks per page, columns per row, actions per container.",
      "Column spans total at most 12 per row. startPageId names an existing page without required parameters.",
      "Record pages are route-only, declare exactly their bound Record parameter, and contain a Record or HTML block.",
      "Navigation supplies every target parameter exactly once with a compatible Record binding.",
      "Referenced resources must exist, be accessible and belong to the expected Base and table; resource IDs are not names.",
      "Cards inherit a saved View. Inline GQL tables use their selected columns; saved-view tables require explicit columnIds.",
      "Record editableFieldIds are a writable subset of fieldIds. Document templates belong to the Record table.",
      "Edit Forms target the page Record's table. Related edits use only configured same-Base inline fields and exclusively linked children.",
      "Workflow and scanner launchers must be enabled and compatible. Bind every required workflow input; App actions do not open prompt forms.",
      "Availability and GQL are compiled with typed request context and bounded result shapes. Unavailable resources fail closed.",
      "Integer formats cannot set decimalPlaces. Only number formats accept unit; unitPosition requires unit.",
    ],
  },
} as const;
