import { z } from "zod";
import { AiTaskRequestSchema, type AiTaskRequestInput } from "@k2b/cloud/ai/browser";

type Options<K extends AiTaskRequestInput["kind"]> = Omit<Extract<AiTaskRequestInput, { kind: K }>, "kind">;
export function createAi(rpc: (method: string, args: unknown[]) => Promise<unknown>) {
  const run = (request: AiTaskRequestInput) => rpc("ai", [AiTaskRequestSchema.parse(request)]);
  return {
    generateText: (options: Options<"generate_text">) => run({ ...options, kind: "generate_text" }).then(value => z.string().parse(value)),
    classify: (options: Options<"classify">) => run({ ...options, kind: "classify" }).then(value => z.string().parse(value)),
    classifyMany: (options: Options<"classify_many">) => run({ ...options, kind: "classify_many" }).then(value => z.array(z.string()).parse(value)),
    extractData: (options: Options<"extract_data">) => run({ ...options, kind: "extract_data" }).then(value => z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).parse(value)),
  };
}
