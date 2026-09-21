import { z } from "zod";
import { runAiStructured, type RunAiStructuredInput } from "./structured";
import type { AiTaskRequest } from "./task-contracts";
type AiTaskValue = z.infer<ReturnType<typeof z.json>>;

const asJson = (value: unknown): AiTaskValue => JSON.parse(JSON.stringify(value)) as AiTaskValue;
const choiceEnum = (values: string[]) => z.enum(values as [string, ...string[]]);
const structuredOutputSchema = (fields: Extract<AiTaskRequest, { kind: "extract_data" }>["fields"]) => {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let schema: z.ZodType =
      field.type === "text"
        ? z.string().max(field.maxLength ?? 20_000)
        : field.type === "number"
          ? z.number()
          : field.type === "boolean"
            ? z.boolean()
            : field.type === "date_time"
              ? z.iso.datetime({ offset: true })
              : choiceEnum(field.choices!);
    if (!field.required) schema = schema.optional();
    shape[field.name] = schema.describe(field.description);
  }
  return z.object(shape).strict();
};

/** Schema-validated AI calculations shared by workflows and interactive code. */
export const executeAiTask = async (
  request: AiTaskRequest,
  options: Pick<RunAiStructuredInput<z.ZodType>, "appId" | "attribution" | "signal" | "requestedModelId" | "resolveModel" | "usageSubject"> & { taskPrefix: string },
  runStructured: typeof runAiStructured = runAiStructured,
) => {
  const { taskPrefix, ...common } = options;
  if (request.kind === "generate_text") {
    const result = await runStructured({
      ...common,
      task: `${taskPrefix}-generate-text`,
      systemPrompt: request.prompt,
      input: request.input === undefined ? "Create the requested text." : JSON.stringify(request.input),
      outputName: "generated_text",
      output: z.object({ text: z.string().max(request.maxOutputChars) }),
      maxOutputTokens: Math.min(8_192, Math.max(64, Math.ceil(request.maxOutputChars / 2))),
    });
    return { output: result.output.text as AiTaskValue, usage: result.usage ? asJson(result.usage) : null };
  }

  if (request.kind === "classify") {
    const result = await runStructured({
      ...common,
      task: `${taskPrefix}-classify`,
      systemPrompt: `${request.prompt}\nReturn exactly one of the declared choices.`,
      input: JSON.stringify(request.input),
      outputName: "classification",
      output: z.object({ choice: choiceEnum(request.choices) }),
      maxOutputTokens: 200,
    });
    return { output: result.output.choice as AiTaskValue, usage: result.usage ? asJson(result.usage) : null };
  }

  if (request.kind === "extract_data") {
    const result = await runStructured({
      ...common,
      task: `${taskPrefix}-extract-data`,
      systemPrompt: `${request.prompt}\nReturn only the declared fields. Do not invent values that are not supported by the input.`,
      input: JSON.stringify(request.input),
      outputName: "structured_data",
      output: structuredOutputSchema(request.fields),
      maxOutputTokens: 4_096,
    });
    return { output: asJson(result.output), usage: result.usage ? asJson(result.usage) : null };
  }

  const maximum = request.maxChoices ?? request.choices.length;
  const result = await runStructured({
    ...common,
    task: `${taskPrefix}-classify-many`,
    systemPrompt: `${request.prompt}\nReturn only unique values from the declared choices.`,
    input: JSON.stringify(request.input),
    outputName: "classifications",
    output: z.object({ choices: z.array(choiceEnum(request.choices)).min(request.minChoices).max(maximum) }),
    maxOutputTokens: 500,
  });
  const selected = new Set(result.output.choices);
  return {
    output: request.choices.filter((choice) => selected.has(choice)) as AiTaskValue,
    usage: result.usage ? asJson(result.usage) : null,
  };
};
