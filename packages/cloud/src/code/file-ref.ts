import { z } from "zod";
import { CapabilityFileMetadataSchema } from "../contracts/capability-streams";
import type { CodeRunTokenClaims } from "./run-token";

export const CodeFileRefSchema = CapabilityFileMetadataSchema.extend({
  id: z.string().min(1).max(8192).describe("Opaque file reference sealed to this Code attempt."),
}).strict();

/** A stable continuation, independent of token renewal but fenced to one executable attempt and mandate. */
export const codeFileBinding = (claims: CodeRunTokenClaims): string =>
  JSON.stringify([
    "code-file-v1",
    claims.codeId,
    claims.versionId,
    claims.bundleHash,
    claims.runId,
    claims.generation,
    claims.mandateId,
    claims.mandateRevision,
  ]);

/** Write streams opt into the generic SDK file argument through their ordinary metadata schema. */
export function hasFileInput(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  return properties !== null && typeof properties === "object" && Object.hasOwn(properties, "file");
}

/** Serialized only by the SDK's private function registry; the bridge validates against checked permissions. */
export const CodeAiToolBindingSchema = z
  .object({
    capability: z.string().min(1).max(256).describe("Generated SDK capability ID."),
    target: z
      .object({ type: z.string().min(1).describe("Bound resource type."), id: z.string().min(1).describe("Bound resource ID.") })
      .strict()
      .nullable()
      .describe("Fixed SDK target; null for app-level operations."),
  })
  .strict();
export type CodeAiToolBinding = z.infer<typeof CodeAiToolBindingSchema>;
