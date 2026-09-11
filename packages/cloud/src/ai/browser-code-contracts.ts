import { z } from "zod";

const id = z.uuid().describe("App ID returned by code_create or code_list.");
const runId = z.string().min(1).max(180).describe("Run ID returned by code_run in this browser.");
export const CODE_RUNTIME_TOOL_NAMES = ["code_run", "code_inspect", "code_interact", "code_stop", "code_open", "code_export"] as const;
export const CodeRunInput = z.object({ id, inputPaths: z.array(z.string().min(1).max(500)).max(64).default([]).describe("Chat file paths supplied to this isolated run.") }).strict();
export const CodeInspectInput = z.object({ runId, nodeId: z.string().min(1).max(80).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) }).strict();
export const CodeInteractInput = z.object({ runId,
  id: z.string().min(1).max(80).describe("Control ID or pending modal ID returned by the snapshot."),
  value: z.json().optional().describe("Input value or modal answer. Use null to cancel a modal."),
  action: z.string().max(80).optional().describe("List action ID, when acting on a list item."),
  item: z.string().max(180).optional().describe("Current list item ID."),
}).strict();
export const CodeStopInput = z.object({ runId }).strict();
export const CodeOpenInput = z.object({ id }).strict();
export const CodeExportInput = z.object({ runId, name: z.string().min(1).max(180).describe("Captured output filename returned by the snapshot.") }).strict();

// Internal bridge envelope. Each model-facing tool receives only its own flat schema.
export const CodeRuntimeInput = z.discriminatedUnion("operation", [
  CodeRunInput.extend({ operation: z.literal("run") }),
  CodeInspectInput.extend({ operation: z.literal("inspect") }),
  CodeInteractInput.extend({ operation: z.literal("interact") }),
  CodeStopInput.extend({ operation: z.literal("stop") }),
  CodeOpenInput.extend({ operation: z.literal("open") }),
  CodeExportInput.extend({ operation: z.literal("export") }),
]);
export type CodeRuntimeInput = z.infer<typeof CodeRuntimeInput>;
export function parseCodeToolInput(name: string, args: unknown): CodeRuntimeInput {
  switch (name) {
    case "code_run": return { operation: "run", ...CodeRunInput.parse(args) };
    case "code_inspect": return { operation: "inspect", ...CodeInspectInput.parse(args) };
    case "code_interact": return { operation: "interact", ...CodeInteractInput.parse(args) };
    case "code_stop": return { operation: "stop", ...CodeStopInput.parse(args) };
    case "code_open": return { operation: "open", ...CodeOpenInput.parse(args) };
    case "code_export": return { operation: "export", ...CodeExportInput.parse(args) };
    default: throw new Error("Unknown code tool");
  }
}
