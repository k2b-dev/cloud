import { CodeSecretBindingSchema, CodeSecretNameSchema, CodeSecretVersionBindingSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { CodeIdSchema } from "./contracts";

export type { CodeSecretBinding, CodeSecretVersionBinding } from "@k2b/cloud/contracts";
export { CodeSecretBindingSchema, CodeSecretNameSchema, CodeSecretVersionBindingSchema } from "@k2b/cloud/contracts";
/** Metadata only. Deleted values leave revision evidence intact for approved versions. */
export const CodeSecretMetadataSchema = CodeSecretVersionBindingSchema.extend({ configured: z.boolean() }).strict();
export type CodeSecretMetadata = z.infer<typeof CodeSecretMetadataSchema>;
/** Stable service/CLI contracts; no read-value operation exists. Values must arrive through private editor input, never a chat tool. */
export const codeSecretContracts = {
  set: {
    input: z
      .object({
        codeId: CodeIdSchema,
        name: CodeSecretNameSchema,
        value: z
          .string()
          .min(1)
          .regex(/^[\x20-\x7e]+$/)
          .describe("Write-only credential; supply through stdin or a private secret field."),
        binding: CodeSecretBindingSchema.optional().describe("Required for a new name; changes create a new immutable binding revision."),
        binding_revision: z.uuid().nullable().describe("Current binding revision for optimistic concurrency, or null for a new name."),
      })
      .strict(),
    data: z.object({ secret: CodeSecretMetadataSchema }).strict(),
  },
  list: {
    input: z
      .object({
        codeId: CodeIdSchema,
        cursor: CodeSecretNameSchema.optional(),
        limit: z.number().int().min(1).max(20).default(20),
      })
      .strict(),
    data: z.object({ items: z.array(CodeSecretMetadataSchema), nextCursor: CodeSecretNameSchema.nullable() }).strict(),
  },
  delete: {
    input: z.object({ codeId: CodeIdSchema, name: CodeSecretNameSchema, binding_revision: z.uuid() }).strict(),
    data: z.object({ deleted: z.boolean() }).strict(),
  },
} as const;
