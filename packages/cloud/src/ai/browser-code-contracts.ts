import { z } from "zod";

export const CodeResourceId = z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}$/).describe("Public resource short ID returned by code_create or code_list.");
const id = CodeResourceId;
const runId = z.string().min(1).max(180).describe("Run ID returned by code_run in this conversation execution host.");
export const CODE_RUNTIME_TOOL_NAMES = ["code_run", "code_action", "code_inspect", "code_interact", "code_stop", "code_open", "code_export", "code_present", "code_secret"] as const;
export const CodeRunInput = z.object({
  id: id.optional(),
  resourceId: id.optional().describe("Optional data context for one-off code. Requires Manage; uses this resource database and shared files/KV without changing its source. Local storage stays temporary."),
  version: z.number().int().positive().optional().describe("Published version to run; resource admins only. Omit for the current accessible source."),
  code: z.string().min(1).max(1024 * 1024).optional().describe("One-off JavaScript/TypeScript entry exporting one function. Use code OR a saved resource id; no title or icon needed."),
  inputPaths: z.array(z.string().min(1).max(500)).max(64).default([]).describe("Explicit current-chat input files. Scripts can read them; app test runs expose them only through the simulated picker. User apps never receive chat files."),
}).strict().refine(input => Number(input.id !== undefined) + Number(input.code !== undefined) === 1, "Provide exactly one of id or code").refine(input => input.version === undefined || input.id !== undefined,"A published version requires a saved resource id").refine(input => input.resourceId === undefined || input.code !== undefined, "resourceId requires one-off code");
export const CodeActionInput = z.object({
  id,
  action: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/).max(80).describe("Exact name returned by code_actions."),
  publishedVersion: z.number().int().positive().optional().describe("Exact publication returned by code_actions; a changed publication requires fresh discovery. Supply this OR draft revision."),
  revision: z.number().int().positive().optional().describe("Exact draft revision returned by code_actions({draft:true}); Manage required. Supply this OR publishedVersion."),
  input: z.json().describe("Action input matching the discovered inputSchema."),
}).strict().refine(input => Number(input.publishedVersion !== undefined) + Number(input.revision !== undefined) === 1, "Supply publishedVersion OR draft revision");
export const CodeInspectInput = z.object({ runId, waitMs: z.number().int().min(0).max(30000).default(0).describe("Wait up to this duration for background work to finish before returning its real state; never restarts work."), nodeId: z.string().min(1).max(80).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) }).strict();
const CodeInteraction = z.object({
  id: z.string().min(1).max(80).describe("Control ID or pending modal ID returned by the snapshot."),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("change"), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(z.string()), z.object({ start: z.iso.date().nullable(), end: z.iso.date().nullable() }).strict()]) }).strict(),
    z.object({ type: z.literal("select"), key: z.string().nullable() }).strict(),
    z.object({ type: z.literal("view"), value: z.enum(["chart", "table"]) }).strict(),
    z.object({ type: z.literal("refresh") }).strict(),
    z.object({ type: z.literal("request"), request: z.record(z.string(), z.json()) }).strict(),
  ]).optional().describe("An event object, never a JSON-encoded string. Omit to activate a button. Example: {type:'change',value:['Sued']} or {type:'view',value:'table'}."),
  answer: z.json().optional().describe("Only for the pending modal ID: the modal answer, or null to cancel. Do not use for controls."),
}).strict();
const validInteraction = (input: z.infer<typeof CodeInteraction>) => input.event === undefined || input.answer === undefined;
export const CodeInteractInput = CodeInteraction.partial({id:true}).extend({
  runId,
  // Three normal 15-second callback budgets share the existing 45-second call budget.
  steps:z.array(CodeInteraction.refine(validInteraction,"Supply event OR answer")).min(1).max(3).optional()
    .describe("Up to three sequential interactions in one call. Use steps OR the top-level id/event/answer. Stops on an error, pending modal or background work; returns completedSteps and nextStep."),
}).strict().refine(input=>input.steps ? input.id===undefined && input.event===undefined && input.answer===undefined : input.id!==undefined && (input.event===undefined || input.answer===undefined),"Supply steps OR one id with event/answer.");
export const CodeStopInput = z.object({ runId }).strict();
export const CodeOpenInput = z.object({ id }).strict();
export const CodePresentInput = z.object({ runId, title: z.string().trim().min(1).max(120) }).strict();
export const CodeExportInput = z.object({ runId, name: z.string().min(1).max(180).describe("Captured output filename returned by the snapshot.") }).strict();

export const CodeSecretInput = z.object({
  resourceId:id.optional().describe("Scope to this app/script; omit to configure the current chat only."),
  name:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
  origin:z.string().url().max(2000).describe("Exact HTTPS origin allowed to receive the secret."),
  header:z.string().min(1).max(80).default("authorization"),
  prefix:z.string().max(160).default("Bearer "),
}).strict();

// Internal bridge envelope. Each model-facing tool receives only its own flat schema.
export const CodeRuntimeInput = z.discriminatedUnion("operation", [
  CodeRunInput.safeExtend({ operation: z.literal("run") }),
  CodeActionInput.safeExtend({ operation: z.literal("action") }),
  CodeInspectInput.extend({ operation: z.literal("inspect") }),
  CodeInteractInput.safeExtend({ operation: z.literal("interact") }),
  CodeStopInput.extend({ operation: z.literal("stop") }),
  CodeOpenInput.extend({ operation: z.literal("open") }),
  CodeSecretInput.extend({ operation: z.literal("secret") }),
  CodePresentInput.extend({ operation: z.literal("present") }),
  CodeExportInput.extend({ operation: z.literal("export") }),
]);
export type CodeRuntimeInput = z.infer<typeof CodeRuntimeInput>;
export function parseCodeToolInput(name: string, args: unknown): CodeRuntimeInput {
  switch (name) {
    case "code_secret": return { operation: "secret", ...CodeSecretInput.parse(args) };
    case "code_action": return { operation: "action", ...CodeActionInput.parse(args) };
    case "code_run": return { operation: "run", ...CodeRunInput.parse(args) };
    case "code_inspect": return { operation: "inspect", ...CodeInspectInput.parse(args) };
    case "code_interact": return { operation: "interact", ...CodeInteractInput.parse(args) };
    case "code_stop": return { operation: "stop", ...CodeStopInput.parse(args) };
    case "code_open": return { operation: "open", ...CodeOpenInput.parse(args) };
    case "code_present": return { operation: "present", ...CodePresentInput.parse(args) };
    case "code_export": return { operation: "export", ...CodeExportInput.parse(args) };
    default: throw new Error("Unknown code tool");
  }
}
