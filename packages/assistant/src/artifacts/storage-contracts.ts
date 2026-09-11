import { z } from "zod";
import { LIMITS } from "./contracts";

// Transport values are text (JSON for kv, base64 for files), bounded by the
// existing runtime RPC budget. The server counts decoded bytes for quotas.
export const StorageRequest = z.object({
  area: z.enum(["kv", "files"]),
  operation: z.enum(["read", "write", "delete", "list"]),
  key: z.string().min(1).max(240).optional(),
  content: z.string().max(LIMITS.rpcBytes).optional(),
  mediaType: z.string().max(200).default(""),
}).strict();
export type StorageRequest = z.infer<typeof StorageRequest>;
