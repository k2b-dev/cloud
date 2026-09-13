import { DatabaseRequest } from "./database-contracts";
import { api } from "@k2b/cloud/browser";
import { z } from "zod";
import type { ApiType } from "../api";
import type { StorageRequest } from "./storage-contracts";
import { ArtifactUpdate, ArtifactSource, type ArtifactKind } from "./contracts";
const client = api.create<ApiType>({ baseUrl: "/api/assistant" }).artifacts;
async function checked(response: Response): Promise<void> {
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : `HTTP ${response.status}`;
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
    throw Object.assign(new Error(message), { code });
  }
}
export const artifactClient = {
  databaseInspect:async(id:string,input:unknown,signal?:AbortSignal)=>{const response=await client[":id"].database.inspect.$post({param:{id},json:DatabaseRequest.parse(input)},{init:{signal}});await checked(response);return response.json();},
  renameSource:async(source:ArtifactSource,from:string,to:string)=>{const response=await client.runtime.rename.$post({json:{source,from,to}});await checked(response);return ArtifactSource.parse(await response.json());},
  databaseStatus: async (id:string) => {const response=await client[":id"].database.status.$get({param:{id}});await checked(response);return response.json();},
  databaseReset: async (id:string,expectedGeneration:string|null) => {const response=await client[":id"].database.reset.$post({param:{id},json:{confirmed:true,expectedGeneration}});await checked(response);return response.json();},
  storageManage: async (id:string,input:StorageRequest) => {const response=await client[":id"].storage.manage.$post({param:{id},json:input});await checked(response);return response.json();},
  storageClear: async (id:string,area:"files"|"kv"|"all") => {const response=await client[":id"].storage.clear.$post({param:{id},json:{area,confirmed:true}});await checked(response);return response.json();},
  remove: async (id:string) => {const response=await client[":id"].$delete({param:{id}});await checked(response);return response.json();},
  capabilityPrepare:async(input:{id:string;name:string;input:unknown;artifactId?:string;conversationId?:string},signal?:AbortSignal)=>{
    const response=await client.runtime.capabilities.$post({json:{...input,input:z.json().parse(input.input)}},{init:{signal}});await checked(response);return response.json();
  },
  capabilityResolve:async(id:string,input:{approved:boolean;remember?:"always"},signal?:AbortSignal)=>{
    const response=await client.runtime.capabilities[":callId"].resolve.$post({param:{callId:id},json:input},{init:{signal}});await checked(response);return response.json();
  },
  projects: async(id:string) => {const response=await client[":id"].projects.$get({param:{id}});await checked(response);return response.json();},
  linkProject: async(id:string,projectId:string,linked:boolean) => {const response=await client[":id"].projects[":projectId"].$put({param:{id,projectId},json:{linked}});await checked(response);return response.json();},
  admin: {
    remove: async (id:string) => {const response=await client.admin.resources[":id"].$delete({param:{id}});await checked(response);return response.json();},
    settings: async () => {const response=await client.admin.database.settings.$get();await checked(response);return response.json();},
    configure: async (input:{url:string;token?:string}) => {const response=await client.admin.database.settings.$put({json:input});await checked(response);return response.json();},
    test: async(input:{url:string;token?:string}) => {const response=await client.admin.database.test.$post({json:input});await checked(response);return response.json();},
    access: async (id:string) => {const response=await client.admin.resources[":id"].access.$get({param:{id}});await checked(response);return response.json();},
    grant: async (id:string,principal:{type:"user";userId:string}|{type:"group";groupId:string}|{type:"authenticated"},permission:"read"|"admin") => {
      const response=await client.admin.resources[":id"].access.$post({param:{id},json:{principal,permission}});await checked(response);return response.json();
    },
    change: async (id:string,accessId:string,permission:"read"|"admin"|null) => {
      const response=await client.admin.resources[":id"].access[":accessId"].$put({param:{id,accessId},json:{permission}});await checked(response);return response.json();
    },
  },
  database: async (id: string,request: unknown,conversationId?: string,signal?: AbortSignal, management = false) => {
    const parsed = DatabaseRequest.safeParse(request);
    const connect = !parsed.success && typeof request === "object" && request !== null && "operation" in request && request.operation === "connect";
    if (!connect && !parsed.success) throw new Error("Invalid database operation");
    const response = await fetch(`/api/assistant/artifacts/${encodeURIComponent(id)}/database${management ? "/maintenance" : ""}${connect ? "/connect" : ""}${conversationId ? "?conversationId="+encodeURIComponent(conversationId) : ""}`,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request),signal,
    });
    await checked(response); return response.json();
  },
  storage: async (id: string,input: StorageRequest,conversationId?: string) => {
    const response = await client[":id"].storage.$post({param:{id},json:input,query:{conversationId}});
    await checked(response); return response.json();
  },
  compile: async (source: ArtifactSource) => {
    const response = await client.runtime.compile.$post({ json: source });
    await checked(response); return response.json();
  },
  list: async (page = 1, kind?: ArtifactKind) => {
    const response = await client.$get({ query: { page: String(page), kind } });
    await checked(response); return response.json();
  },
  get: async (id: string, published = false, version?: number, conversationId?: string) => {
    const response = await client[":id"].$get({ param: { id }, query: { conversationId, ...(published ? { published: "true" as const } : {}), ...(version ? {version:String(version)} : {}) } });
    await checked(response); return response.json();
  },
  publish: async (id: string, expectedRevision: number, note: string) => {
    const response = await client[":id"].publish.$post({ param: { id }, json: { expectedRevision, note } });
    await checked(response); return response.json();
  },
  unpublish: async (id: string) => {
    const response = await client[":id"].unpublish.$post({ param: { id } });
    await checked(response); return response.json();
  },
  fork: async (id: string) => {
    const response = await client[":id"].fork.$post({ param: { id } });
    await checked(response); return response.json();
  },
  editChat: async (id: string) => {
    const response = await client[":id"]["edit-chat"].$post({ param: { id } });
    await checked(response); return response.json();
  },
  versions: async (id: string, page = 1) => {
    const response = await client[":id"].versions.$get({param:{id},query:{page:String(page)}});
    await checked(response); return response.json();
  },
  restore: async (id: string, version: number, expectedRevision: number) => {
    const response = await client[":id"].restore.$post({param:{id},json:{version,expectedRevision}});
    await checked(response); return response.json();
  },
  access: async (id: string) => {
    const response = await client[":id"].access.$get({ param: { id } });
    await checked(response); return response.json();
  },
  grant: async (id: string, principal: { type: "user"; userId: string } | { type: "group"; groupId: string } | { type: "authenticated" }, permission: "read" | "admin") => {
    const response = await client[":id"].access.$post({ param: { id }, json: { principal, permission } });
    await checked(response); return response.json();
  },
  changeGrant: async (id: string, accessId: string, permission: "read" | "admin" | null) => {
    const response = await client[":id"].access[":accessId"].$put({ param: { id, accessId }, json: { permission } });
    await checked(response); return response.json();
  },
  update: async (id: string, input: z.infer<typeof ArtifactUpdate>) => {
    const response = await client[":id"].$put({ param: { id }, json: input });
    await checked(response);
    const result = await response.json();
    window.dispatchEvent(new Event("assistant-artifact-saved"));
    return result;
  },
  compiled: async (id: string, revision: number, conversationId?: string) => {
    const response = await client[":id"].compiled.$get({ param: { id }, query: { revision: String(revision), conversationId } });
    await checked(response);
    return z.object({ runtime: z.string(), code: z.string(), revision: z.number().int() }).parse(await response.json());
  },
};
