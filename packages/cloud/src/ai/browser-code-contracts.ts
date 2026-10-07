import { z } from "zod";

export const CodeResourceId = z
  .string()
  .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}$/)
  .describe("Public resource short ID returned by code_create or code_list.");
const id = CodeResourceId;
const runId = z.string().min(1).max(180).describe("Run ID returned by code_run in this conversation execution host.");
export const CODE_RUNTIME_TOOL_NAMES = [
  "code_run",
  "code_action",
  "code_inspect",
  "code_stop",
  "code_open",
  "code_export",
  "code_present",
  "code_secret",
] as const;
export const CodeRunInput = z
  .object({
    id: id.optional().describe("Saved script resource to run; an app with an index.html interface opens with code_open instead."),
    resourceId: id
      .optional()
      .describe(
        "Optional data context for one-off code. Requires Manage; uses this resource database and shared files/KV without changing its source. Runs use real shared and personal data; writes and capability effects keep normal permissions and approvals.",
      ),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Published version to run; resource admins only. Omit for the current accessible source."),
    code: z
      .string()
      .min(1)
      .max(1024 * 1024)
      .optional()
      .describe("One-off JavaScript/TypeScript script exporting one function. Use code OR a saved resource id; no title or icon needed."),
    inputPaths: z
      .array(z.string().min(1).max(500))
      .max(64)
      .default([])
      .describe("Explicit current-chat input files; the script reads them from its context files. Apps never receive chat files."),
  })
  .strict()
  .refine((input) => Number(input.id !== undefined) + Number(input.code !== undefined) === 1, "Provide exactly one of id or code")
  .refine((input) => input.version === undefined || input.id !== undefined, "A published version requires a saved resource id")
  .refine((input) => input.resourceId === undefined || input.code !== undefined, "resourceId requires one-off code");
export const CodeActionInput = z
  .object({
    id,
    action: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9_]*$/)
      .max(80)
      .describe("Exact name returned by code_actions."),
    publishedVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Exact publication returned by code_actions; a changed publication requires fresh discovery. Supply this OR draft revision.",
      ),
    revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Exact draft revision returned by code_actions({draft:true}); Manage required. Supply this OR publishedVersion."),
    input: z
      .record(z.string(), z.json())
      .default({})
      .describe("Action input object matching the discovered inputSchema. Pass the object itself, never JSON text."),
  })
  .strict()
  .refine(
    (input) => Number(input.publishedVersion !== undefined) + Number(input.revision !== undefined) === 1,
    "Supply publishedVersion OR draft revision",
  );
export const CodeInspectInput = z
  .object({
    runId,
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(30000)
      .default(0)
      .describe("Wait up to this duration for background work to finish before returning its real state; never restarts work."),
  })
  .strict();
export const CodeStopInput = z.object({ runId }).strict();
export const CodeOpenInput = z.object({ id }).strict();
const AppFilePath = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine((path) => path.split("/").every((part) => part !== "." && part !== ".."), "Expected a relative path without . or ..");
export const CodePresentInput = z
  .object({
    id: id.optional().describe("Saved app with an index.html interface; the card runs it live with its data. Omit title to use the app title."),
    files: z
      .array(z.object({ path: AppFilePath, content: z.string().max(1024 * 1024) }).strict())
      .min(1)
      .max(64)
      .optional()
      .describe("One-off app for this chat: index.html plus optional style.css, app.js and other modules. It has no saved data."),
    title: z.string().trim().min(1).max(120).optional().describe("Card title; required with files."),
  })
  .strict()
  .refine((input) => Number(input.id !== undefined) + Number(input.files !== undefined) === 1, "Provide exactly one of id or files")
  .refine((input) => input.id !== undefined || input.title !== undefined, "A one-off app needs a title")
  .refine((input) => !input.files || input.files.some((file) => file.path === "index.html"), "files must contain index.html");
export const CodeExportInput = z
  .object({ runId, name: z.string().min(1).max(180).describe("Captured output filename returned by the snapshot.") })
  .strict();

export const CodeSecretInput = z
  .object({
    resourceId: id.optional().describe("Scope to this app/script; omit to configure the current chat only."),
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
    origin: z.string().url().max(2000).describe("Exact HTTPS origin allowed to receive the secret."),
    header: z.string().min(1).max(80).default("authorization"),
    prefix: z.string().max(160).default("Bearer "),
  })
  .strict();

/**
 * A runtime call that did not complete: rejected input, timeout, lost run or host failure.
 * Hosts return it as data because a client tool result carries no error flag; the managed
 * server tools report it to the model as a tool error. A run snapshot whose code failed is a
 * completed call and keeps its own `status` and `error`.
 */
export const CodeToolFailure = z.object({ failed: z.literal(true), error: z.string(), guidance: z.string().optional() });
export type CodeToolFailure = z.infer<typeof CodeToolFailure>;

// Internal bridge envelope. Each model-facing tool receives only its own flat schema.
export const CodeRuntimeInput = z.discriminatedUnion("operation", [
  CodeRunInput.safeExtend({ operation: z.literal("run") }),
  CodeActionInput.safeExtend({ operation: z.literal("action") }),
  CodeInspectInput.extend({ operation: z.literal("inspect") }),
  CodeStopInput.extend({ operation: z.literal("stop") }),
  CodeOpenInput.extend({ operation: z.literal("open") }),
  CodeSecretInput.extend({ operation: z.literal("secret") }),
  CodePresentInput.safeExtend({ operation: z.literal("present") }),
  CodeExportInput.extend({ operation: z.literal("export") }),
]);
export type CodeRuntimeInput = z.infer<typeof CodeRuntimeInput>;
export function parseCodeToolInput(name: string, args: unknown): CodeRuntimeInput {
  switch (name) {
    case "code_secret":
      return { operation: "secret", ...CodeSecretInput.parse(args) };
    case "code_action":
      return { operation: "action", ...CodeActionInput.parse(args) };
    case "code_run":
      return { operation: "run", ...CodeRunInput.parse(args) };
    case "code_inspect":
      return { operation: "inspect", ...CodeInspectInput.parse(args) };
    case "code_stop":
      return { operation: "stop", ...CodeStopInput.parse(args) };
    case "code_open":
      return { operation: "open", ...CodeOpenInput.parse(args) };
    case "code_present":
      return { operation: "present", ...CodePresentInput.parse(args) };
    case "code_export":
      return { operation: "export", ...CodeExportInput.parse(args) };
    default:
      throw new Error("Unknown code tool");
  }
}
