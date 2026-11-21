import { z } from "zod";

/** Resource types that own Code, and their shared Code pages. */
export type CapabilityCodeDefinition = {
  owners?: readonly string[];
  pages?: Readonly<Record<string, string>>;
  /**
   * `false`: a public Code route never calls a Query of this app, not even with `audience: "owner-data"`. The checker
   * refuses such a version and Core refuses such an answer, so the app's data never reaches a visitor without an
   * account.
   */
  publicRoutes?: false;
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
          // One path on this Cloud: a leading "//" would name another host.
          .regex(/^\/(?!\/)[^\\\u0000-\u001f\u007f]*\{id\}[^\\\u0000-\u001f\u007f]*$/),
      )
      .optional(),
    publicRoutes: z.literal(false).optional(),
  })
  .strict();
export type CapabilityCodeManifest = z.infer<typeof CapabilityCodeManifestSchema>;
