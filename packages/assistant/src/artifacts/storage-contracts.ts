import { z } from "zod";
import { LIMITS } from "./contracts";

// KV JSON escaping can require six bytes per character. Files use binary HTTP.
export const STORAGE_TRANSPORT_BYTES = LIMITS.rpcBytes * 6 + 4096;
export const StorageRequest = z
  .object({
    area: z.enum(["kv", "files"]),
    operation: z.enum(["read", "write", "delete", "list"]),
    after: z.string().max(240).default(""),
    limit: z.number().int().min(1).max(1000).default(1000),
    key: z.string().min(1).max(240).optional(),
    content: z
      .string()
      .max(Math.ceil(LIMITS.rpcBytes / 3) * 4)
      .optional(),
    mediaType: z.string().max(200).default(""),
  })
  .strict();
export type StorageRequest = z.infer<typeof StorageRequest>;

// Binary transfers are bounded independently from JSON/runtime messages.
export const STORAGE_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const StorageFileQuery = z.object({
  key: z.string().min(1).max(240),
  conversationId: z.string().max(80).optional(),
  management: z.enum(["true"]).optional(),
});
export const StorageJsonRequest = StorageRequest.refine(
  (input) => input.area !== "files" || input.operation === "list" || input.operation === "delete",
  "Use the binary storage/file endpoint to read or write files",
);
