import { z } from "zod";

/** Resource types that own Code, and their shared Code pages. */
export type CapabilityCodeDefinition = {
  owners?: readonly string[];
  pages?: Readonly<Record<string, string>>;
};

export const CapabilityCodeManifestSchema = z
  .object({
    owners: z.array(z.string().min(1).max(100)).max(200),
    pages: z
      .record(
        z.string().min(1).max(100),
        z
          .string()
          .max(500)
          .regex(/^\/[^\\\u0000-\u001f\u007f]*\{id\}[^\\\u0000-\u001f\u007f]*$/),
      )
      .optional(),
  })
  .strict();
export type CapabilityCodeManifest = z.infer<typeof CapabilityCodeManifestSchema>;
