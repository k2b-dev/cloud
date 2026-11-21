import { z } from "zod";

/** Metadata-only projection shared by private editor surfaces; Core owns the domain contract. */
export const SecretSchema = z.object({
  name: z.string(),
  binding_revision: z.string(),
  origin: z.string(),
  pathPrefix: z.string(),
  headers: z.array(z.string()),
  configured: z.boolean(),
});
export const SecretListSchema = z.object({
  items: z.array(SecretSchema.extend({ valueSetBy: z.string().nullable(), valueSetAt: z.string().nullable() })),
  nextCursor: z.string().nullable(),
});
export const SecretSetSchema = z.object({ secret: SecretSchema });
