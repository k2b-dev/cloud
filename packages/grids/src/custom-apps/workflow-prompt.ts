import type { WorkflowIrInput } from "@k2b/cloud/workflows";
import { z } from "zod";
import { GQL_PARAMETER_LIMITS } from "../query-dsl/parameters";

export const CustomAppWorkflowPromptResponseSchema = z
  .object({
    inputs: z
      .array(
        z
          .object({
            name: z.string(),
            type: z.enum(["text", "number", "decimal", "date", "dateTime", "boolean", "select"]),
            config: z
              .object({
                label: z.string().optional(),
                description: z.string().optional(),
                required: z.boolean().optional(),
                options: z.array(z.string()).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/** Expose only the approved scalar form contract, never the workflow's private bindings. */
export const projectCustomAppPromptInputs = (inputs: WorkflowIrInput[], names: string[]) =>
  CustomAppWorkflowPromptResponseSchema.parse({
    inputs: names.map((name) => {
      const input = inputs.find((candidate) => candidate.name === name);
      if (!input) throw new Error("Published workflow prompt input is missing");
      return {
        name: input.name,
        type: input.type,
        config: Object.fromEntries(
          Object.entries(input.config).filter(([key]) => ["label", "description", "required", "options"].includes(key)),
        ),
      };
    }),
  });

/** Client values never overwrite server-resolved record or literal bindings. */
export const customAppPromptValuesAllowed = (values: Record<string, unknown>, names: string[], bindings: Record<string, unknown>) =>
  Object.keys(values).every((name) => names.includes(name) && !Object.hasOwn(bindings, name));

/** Use the same scalar transport budget as workflow query parameters. */
export const CustomAppPromptValuesSchema = z
  .record(z.string().max(120), z.union([z.string().max(GQL_PARAMETER_LIMITS.characters), z.number(), z.boolean(), z.null()]))
  .refine((values) => Object.keys(values).length <= GQL_PARAMETER_LIMITS.names)
  .refine((values) => JSON.stringify(values).length <= GQL_PARAMETER_LIMITS.characters);
