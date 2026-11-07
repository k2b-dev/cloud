import { z } from "zod";
export const RuntimeStorage = z
  .object({
    scope: z.enum(["user", "shared"]),
    area: z.enum(["kv", "files"]),
    operation: z.enum(["read", "write", "delete", "list"]),
    after: z.string().max(240).default(""),
    limit: z.number().int().min(1).max(1000).default(100),
    key: z.string().min(1).max(240).optional(),
    value: z.unknown().optional(),
  })
  .strict();
