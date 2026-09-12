import { z } from "zod";
import { LIMITS } from "./contracts";

// JSON escaping needs up to six bytes per character; base64 uses four per three.
// Decoded storage quotas remain unchanged.
export const STORAGE_TRANSPORT_BYTES = LIMITS.rpcBytes * 6 + 4096;
export const StorageRequest = z.object({
  area: z.enum(["kv", "files"]),
  operation: z.enum(["read", "write", "delete", "list"]),
  after: z.string().max(240).default(""),
  limit: z.number().int().min(1).max(1000).default(1000),
  key: z.string().min(1).max(240).optional(),
  content: z.string().max(Math.ceil(LIMITS.rpcBytes / 3) * 4).optional(),
  mediaType: z.string().max(200).default(""),
}).strict();
export type StorageRequest = z.infer<typeof StorageRequest>;
