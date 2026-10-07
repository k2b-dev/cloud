import { z } from "zod";
import { artifactClient } from "../client";
import { CloudError } from "./errors";

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

export async function sharedStorage(id: string, request: z.infer<typeof RuntimeStorage>, conversationId?: string, management = false) {
  if (request.area === "files" && (request.operation === "read" || request.operation === "write")) {
    if (!request.key) throw new Error("File key required");
    let data: Blob | undefined;
    if (request.operation === "write") {
      if (typeof request.value !== "string" && !(request.value instanceof Blob)) throw new Error("Expected text or Blob");
      data = request.value instanceof Blob ? request.value : new Blob([request.value], { type: "text/plain" });
      if (data.size > 16 * 1024 * 1024) throw new CloudError("limit", "Files may contain at most 16 MiB; split this file.");
    }
    const result = await artifactClient.storageFile(id, request.key, { data, conversationId, management });
    return result ? new File([result], request.key.split("/").pop()!, { type: result.type }) : null;
  }
  const input = {
    scope: request.scope,
    area: request.area,
    operation: request.operation,
    key: request.key,
    after: request.after,
    limit: request.limit,
    content: request.operation === "write" ? JSON.stringify(request.value) : undefined,
    mediaType: "",
  };
  const result = await (management ? artifactClient.storageManage(id, input) : artifactClient.storage(id, input, conversationId));
  if ("items" in result) return result.items?.map((item) => item.key) ?? [];
  if ("item" in result && result.item) return JSON.parse(result.item.content);
  return null;
}
