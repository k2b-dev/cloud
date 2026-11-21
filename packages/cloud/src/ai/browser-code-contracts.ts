import { z } from "zod";

export const CodeResourceId = z
  .string()
  .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}$/)
  .describe("Public six-character Cloud resource ID.");
const runId = z.string().min(1).max(180).describe("Run ID returned by code_run in this conversation execution host.");
export const CODE_RUNTIME_TOOL_NAMES = ["code_run", "code_inspect", "code_stop", "code_export", "code_secret"] as const;
export const CodeRunInput = z
  .object({
    code: z
      .string()
      .min(1)
      .max(1024 * 1024)
      .describe("One-off JavaScript/TypeScript module exporting one function."),
    inputPaths: z.array(z.string().min(1).max(500)).max(64).default([]).describe("Explicit current-chat input files."),
  })
  .strict();
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
export const CodeExportInput = z
  .object({ runId, name: z.string().min(1).max(180).describe("Captured output filename returned by the snapshot.") })
  .strict();

export const CodeSecretInput = z
  .object({
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
  CodeInspectInput.extend({ operation: z.literal("inspect") }),
  CodeStopInput.extend({ operation: z.literal("stop") }),
  CodeSecretInput.extend({ operation: z.literal("secret") }),
  CodeExportInput.extend({ operation: z.literal("export") }),
]);
export type CodeRuntimeInput = z.infer<typeof CodeRuntimeInput>;
export function parseCodeToolInput(name: string, args: unknown): CodeRuntimeInput {
  switch (name) {
    case "code_secret":
      return { operation: "secret", ...CodeSecretInput.parse(args) };
    case "code_run":
      return { operation: "run", ...CodeRunInput.parse(args) };
    case "code_inspect":
      return { operation: "inspect", ...CodeInspectInput.parse(args) };
    case "code_stop":
      return { operation: "stop", ...CodeStopInput.parse(args) };
    case "code_export":
      return { operation: "export", ...CodeExportInput.parse(args) };
    default:
      throw new Error("Unknown code tool");
  }
}
