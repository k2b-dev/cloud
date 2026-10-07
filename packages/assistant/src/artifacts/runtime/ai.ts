import { type AiTaskRequestInput, AiTaskRequestSchema } from "@k2b/cloud/ai/browser";
import { z } from "zod";

type Options<K extends AiTaskRequestInput["kind"]> = Omit<Extract<AiTaskRequestInput, { kind: K }>, "kind">;
export function createAi(rpc: (method: string, args: unknown[]) => Promise<unknown>) {
  const run = async (request: AiTaskRequestInput) => rpc("ai", [AiTaskRequestSchema.parse(request)]);
  return {
    text: (options: Options<"generate_text">) => run({ ...options, kind: "generate_text" }).then((value) => z.string().parse(value)),
    classify: async (options: Options<"classify"> & { multiple?: true | { min?: number; max?: number } }) => {
      const { multiple, ...request } = options;
      return multiple
        ? run({
            ...request,
            ...(typeof multiple === "object" ? { minChoices: multiple.min, maxChoices: multiple.max } : {}),
            kind: "classify_many",
          }).then((value) => z.array(z.string()).parse(value))
        : run({ ...request, kind: "classify" }).then((value) => z.string().parse(value));
    },
    extract: (options: Options<"extract_data">) =>
      run({ ...options, kind: "extract_data" }).then((value) =>
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).parse(value),
      ),
  };
}
