import { z } from "zod";
import { artifactClient } from "../client";

export const RuntimeStorage = z.object({
  scope:z.enum(["local","shared"]), area:z.enum(["kv","files"]),
  operation:z.enum(["read","write","delete","list"]),
  after:z.string().max(240).default(""), limit:z.number().int().min(1).max(1000).default(1000),
  key:z.string().min(1).max(240).optional(), value:z.unknown().optional(),
}).strict();

export function localStorageCall(request: z.infer<typeof RuntimeStorage>) {
  const operations = request.area === "kv"
    ? {read:"store.get",write:"store.set",delete:"store.delete",list:"store.keys"}
    : {read:"opfs.read",write:"opfs.write",delete:"opfs.delete",list:"opfs.list"};
  return {method:operations[request.operation],args:request.operation === "list" ? [{after:request.after,limit:request.limit}] : [request.key,request.value]};
}

export async function sharedStorage(id: string, request: z.infer<typeof RuntimeStorage>, conversationId?: string, management = false) {
  if (request.area === "files" && (request.operation === "read" || request.operation === "write")) {
    if (!request.key) throw new Error("File key required");
    let data: Blob | undefined;
    if (request.operation === "write") {
      if (typeof request.value !== "string" && !(request.value instanceof Blob)) throw new Error("Expected text or Blob");
      data=request.value instanceof Blob ? request.value : new Blob([request.value],{type:"text/plain"});
    }
    return artifactClient.storageFile(id,request.key,{data,conversationId,management});
  }
  const input = {area:request.area,operation:request.operation,key:request.key,after:request.after,limit:request.limit,
    content:request.operation === "write" ? JSON.stringify(request.value) : undefined,mediaType:""};
  const result = await (management ? artifactClient.storageManage(id,input) : artifactClient.storage(id,input,conversationId));
  if ("items" in result) return result.items?.map(item=>item.key) ?? [];
  if ("item" in result && result.item) return JSON.parse(result.item.content);
  return null;
}
