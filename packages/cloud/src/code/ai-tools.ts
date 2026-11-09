import { defineTool, type ServerTool } from "@k2b/nessi";
import { z } from "zod";
import { getCapability } from "../_internal/registry";
import type { CodeVersionPermission } from "../contracts/code-version";
import { type CodeAiToolBinding, CodeFileRefSchema, hasFileInput } from "./file-ref";
import type { CodeSdkInvocation } from "./types";

/** Checked evidence narrows tool admission. Dispatch still authorizes every actual call against current policy. */
export function codeAiToolCovered(
  binding: CodeAiToolBinding,
  permissions: readonly Pick<CodeVersionPermission, "operation" | "target">[],
): boolean {
  return permissions.some(
    (permission) =>
      permission.operation === binding.capability &&
      (binding.target === null
        ? permission.target === null
        : permission.target?.type === binding.target.type && (permission.target.id === null || permission.target.id === binding.target.id)),
  );
}
export async function createCodeAiTools(options: {
  bindings: readonly CodeAiToolBinding[];
  permissions: readonly CodeVersionPermission[];
  invoke: (invocation: CodeSdkInvocation) => Promise<unknown>;
  registerFiles: (value: unknown) => void;
  requestId: string;
  getCapability?: typeof getCapability;
}): Promise<ServerTool[]> {
  let sequence = 0;
  return Promise.all(
    options.bindings.map(async (binding, index) => {
      if (!codeAiToolCovered(binding, options.permissions)) throw new Error("code_ai_tool_not_checked");
      const split = binding.capability.indexOf(".");
      const appId = binding.capability.slice(0, split),
        localId = binding.capability.slice(split + 1);
      const entry = await (options.getCapability ?? getCapability)(appId);
      const operation =
        entry?.manifest.queries.find((op) => op.localId === localId) ?? entry?.manifest.actions.find((op) => op.localId === localId);
      if (
        !operation ||
        (operation.target ?? null) !== (binding.target?.type.slice(appId.length + 1) ?? null) ||
        Object.keys(operation.refs ?? {}).length
      )
        throw new Error("code_ai_tool_invalid");
      // The advertised input contains only business data. Targets, account and authority never come from the model.
      const properties = operation.inputSchema.properties;
      const input = z.fromJSONSchema(
        operation.stream?.direction === "write" && hasFileInput(operation.inputSchema) && properties && typeof properties === "object"
          ? { ...operation.inputSchema, properties: { ...properties, file: z.toJSONSchema(CodeFileRefSchema) } }
          : operation.inputSchema,
      );
      return defineTool({
        name: `sdk_${index}`,
        description: `${binding.capability}: ${operation.description}`,
        inputSchema: input,
        timeoutMs: false,
      }).server(async (args) => {
        const metadata =
          "idempotency" in operation && operation.idempotency === "required"
            ? { idempotencyKey: `ai:${options.requestId}:${++sequence}` }
            : {};
        const result = await options.invoke({
          call: { capability: binding.capability, target: binding.target, refs: {}, input: args },
          metadata,
        });
        options.registerFiles(result);
        return { untrusted_tool_result: result };
      });
    }),
  );
}
