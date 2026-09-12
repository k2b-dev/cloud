import { stringify } from "yaml";
import type { z } from "zod";
import type { DocumentQueryOutputSchema } from "../../../service/document-query-output";
import type { WorkflowQueryParameters } from "../../../workflows/query-parameters";

export type FreeQueryOutput = Exclude<z.input<typeof DocumentQueryOutputSchema>, { kind: "datev-csv" | "sepa-xml" }>;
export type QueryExportInput = { name: string; type: Exclude<WorkflowQueryParameters[string]["type"], "record" | "recordList"> };

/** The starter produces the same source the normal workflow editor validates.
 * Query text and Liquid bodies are YAML values, never interpolated YAML. */
export const queryExportWorkflowSource = (
  query: string,
  output: FreeQueryOutput,
  parameters?: WorkflowQueryParameters,
  inputs: QueryExportInput[] = [],
) =>
  stringify(
    {
      ...(inputs.length
        ? {
            inputs: Object.fromEntries(
              inputs.map((input) => [input.name, { type: input.type === "decimal" ? "text" : input.type, required: true }]),
            ),
          }
        : {}),
      steps: [
        {
          query: {
            source: query,
            ...(parameters || inputs.length
              ? {
                  parameters: {
                    ...parameters,
                    ...Object.fromEntries(inputs.map((input) => [input.name, { type: input.type, value: `\${{ inputs.${input.name} }}` }])),
                  },
                }
              : {}),
            saveAs: "report",
          },
        },
        { generateDocument: { data: "report", output, saveAs: "exported" } },
      ],
    },
    { lineWidth: 100, aliasDuplicateObjects: false },
  );
