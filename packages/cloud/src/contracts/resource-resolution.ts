import { z } from "zod";
import { CloudResourceHrefSchema, CloudResourceRefSchema } from "./capabilities";

export const ResolvedCloudResourceUrlSchema = z
  .object({
    ref: CloudResourceRefSchema,
    title: z.string().min(1).max(500),
    icon: z.string().min(1).max(120).optional(),
    href: CloudResourceHrefSchema,
  })
  .strict();

export type ResolvedCloudResourceUrl = z.infer<typeof ResolvedCloudResourceUrlSchema>;
