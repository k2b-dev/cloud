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

export async function sharedStorage(id: string, request: z.infer<typeof RuntimeStorage>, conversationId?: string) {
  let content: string | undefined, mediaType = "";
  if (request.operation === "write") {
    if (request.area === "kv") content = JSON.stringify(request.value);
    else {
      if (typeof request.value !== "string" && !(request.value instanceof Blob)) throw new Error("Expected text or Blob");
      const blob = request.value instanceof Blob ? request.value : new Blob([request.value],{type:"text/plain"});
      mediaType = blob.type;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
      content = btoa(binary);
    }
  }
  const result = await artifactClient.storage(id,{area:request.area,operation:request.operation,key:request.key,after:request.after,limit:request.limit,content,mediaType},conversationId);
  if ("items" in result) return result.items?.map(item=>item.key) ?? [];
  if ("item" in result && result.item) {
    if (request.area === "kv") return JSON.parse(result.item.content);
    return new Blob([Uint8Array.from(atob(result.item.content),char=>char.charCodeAt(0))],{type:result.item.mediaType});
  }
  return null;
}
