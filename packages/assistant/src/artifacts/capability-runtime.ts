import { CodeResourceId } from "@k2b/cloud/ai/browser";
import { sql } from "bun";
import { z } from "zod";
import { getCapabilityCatalogApp, invokeCapability, reviewCapabilityAction, type CapabilityCaller } from "@k2b/cloud/capabilities/server";
import { aiConversations, hasRememberedAiToolApproval, rememberAiToolApproval } from "@k2b/cloud/ai";
import { CapabilityActionReviewSchema } from "@k2b/cloud/contracts";
import { artifacts, ArtifactError, user, type ArtifactIdentity } from "./service";
import { LIMITS } from "./contracts";

export const RuntimeCapabilityRequest=z.object({
  id:z.uuid(),name:z.string().regex(/^[a-z0-9-]+\.[a-zA-Z0-9_.-]+$/).max(240),input:z.json(),
  artifactId:CodeResourceId.optional(),conversationId:z.string().min(1).max(80).optional(),
}).strict().refine(value=>value.artifactId||value.conversationId,"A resource or current conversation is required");
const Prepared=z.object({
  appId:z.string(),localId:z.string(),kind:z.enum(["query","action"]),schemaHash:z.string(),
  approval:z.enum(["none","rememberable"]).nullable(),
  resource:z.object({id:CodeResourceId,title:z.string()}).optional(),
  title:z.string(),review:CapabilityActionReviewSchema.nullable(),allowAlways:z.boolean(),scope:z.string().nullable(),
});
type Request=z.infer<typeof RuntimeCapabilityRequest>;
type Row={id:string;request:unknown;prepared:unknown;status:string;result:unknown};
const decoded = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;

// Nested Assistant capabilities retain the authorized script's chat context.
// A request ID alone grants nothing: it must belong to this user, exact target,
// and a currently executing call; resource access is still checked by the target.
async function authorize(request:Request,identity:ArtifactIdentity) {
  const actor=user(identity);
  const resource=request.artifactId ? await artifacts.get(request.artifactId,{...identity,conversationId:request.conversationId}) : undefined;
  if(request.conversationId){
    const conversation=z.uuid().safeParse(request.conversationId).success
      ? await aiConversations.getConversation({conversationId:request.conversationId,ownerUserId:actor.id})
      : await aiConversations.getConversationByShortId({shortId:request.conversationId,ownerUserId:actor.id});
    if(!conversation||conversation.archivedAt)throw new ArtifactError("ACCESS_DENIED");
    if(conversation.allowedTools && !conversation.allowedTools.includes(request.name))throw new ArtifactError("ACCESS_DENIED");
  }
  return resource;
}
async function operation(name:string,locale?:string|null){
  const split=name.indexOf("."),appId=name.slice(0,split),localId=name.slice(split+1);
  const catalog=await getCapabilityCatalogApp(appId,locale??undefined);
  if(!catalog.ok)throw new Error(catalog.error.message);
  if(!catalog.data)throw new ArtifactError("NOT_FOUND");
  const query=catalog.data.manifest.queries.find(item=>item.localId===localId);
  const action=catalog.data.manifest.actions.find(item=>item.localId===localId);
  if(Boolean(query)===Boolean(action))throw new ArtifactError("INVALID_INPUT");
  return {appId,localId,operation:(query??action)!,action,kind:query?"query" as const:"action" as const};
}

export const runtimeCapabilities={
  async prepare(input:unknown,identity:ArtifactIdentity,caller:CapabilityCaller){
    const request=RuntimeCapabilityRequest.parse(input),actor=user(identity);
    const resource=await authorize(request,identity);
    const untrusted=resource && resource.permission!=="admin";
    const target=await operation(request.name,caller.locale);
    let review:z.infer<typeof CapabilityActionReviewSchema>|null=null;
    if(target.action?.review){
      const response=await reviewCapabilityAction({appId:target.appId,capabilityId:target.localId,input:request.input,signal:caller.signal},caller);
      if(!response.ok)throw new Error(response.error.message);
      review=response.data;
    }
    const scope=target.action?.approval==="rememberable" ? review?.approvalScope??null : null;
    const prepared=Prepared.parse({appId:target.appId,localId:target.localId,kind:target.kind,schemaHash:target.operation.schemaHash,
      approval:target.action?.approval??null,title:target.operation.title,review,allowAlways:!untrusted && scope!==null,scope,
      ...(untrusted ? {resource:{id:resource.id,title:resource.title}} : {})});
    await sql.begin(async db=>{
      await db`SELECT pg_advisory_xact_lock(hashtext(${"assistant-capabilities:"+actor.id}))`;
      await db`UPDATE assistant.capability_calls SET status='abandoned' WHERE user_id=${actor.id}::uuid
        AND status IN ('pending','running') AND created_at < now()-interval '1 day'`;
      const [pending]=await db<{count:number}[]>`SELECT count(*)::int AS count FROM assistant.capability_calls WHERE user_id=${actor.id}::uuid AND status IN ('pending','running')`;
      if(pending!.count>=LIMITS.pendingRequests)throw new ArtifactError("TOO_MANY_REQUESTS");
      await db`INSERT INTO assistant.capability_calls(id,user_id,artifact_id,conversation_id,request,prepared)
        VALUES(${request.id}::uuid,${actor.id}::uuid,(SELECT id FROM assistant.artifacts WHERE short_id=${request.artifactId??null}),${request.conversationId??null},(${JSON.stringify(request)}::text)::jsonb,(${JSON.stringify(prepared)}::text)::jsonb)`;
      // Only recent completed transport results are needed; canonical execution
      // history remains in the platform's capabilities.executions table.
      await db`DELETE FROM assistant.capability_calls WHERE id IN (SELECT id FROM assistant.capability_calls
        WHERE user_id=${actor.id}::uuid AND status IN ('completed','denied','abandoned') ORDER BY created_at DESC OFFSET ${LIMITS.logs})`;
    });
    const remembered=!untrusted && scope!==null && await hasRememberedAiToolApproval({actorUserId:actor.id},{toolName:request.name,approvalScope:scope});
    if(!untrusted && (!target.action||target.action.approval==="none"||remembered))
      return runtimeCapabilities.resolve(request.id,{approved:true},identity,caller);
    return {status:"approval" as const,id:request.id,name:request.name,input:request.input,...prepared};
  },
  async resolve(id:string,decision:{approved:boolean;remember?:"always"},identity:ArtifactIdentity,caller:CapabilityCaller){
    z.uuid().parse(id);const actor=user(identity);
    const [row]=await sql<Row[]>`SELECT * FROM assistant.capability_calls WHERE id=${id}::uuid AND user_id=${actor.id}::uuid`;
    if(!row)throw new ArtifactError("NOT_FOUND");
    // Declining has no effect to authorize or review. It must still work when
    // access was revoked or the target application is temporarily unavailable.
    if (!decision.approved && row.status === "pending") {
      const denied = await sql`UPDATE assistant.capability_calls SET status='denied'
        WHERE id=${id}::uuid AND user_id=${actor.id}::uuid AND status='pending' RETURNING id`;
      if (!denied.length) throw new ArtifactError("CONFLICT");
      return {status:"denied" as const};
    }
    const request=RuntimeCapabilityRequest.parse(decoded(row.request)),prepared=Prepared.parse(decoded(row.prepared));
    const resource=await authorize(request,identity);
    if(resource && resource.permission!=="admin" && !prepared.resource)throw new ArtifactError("CONFLICT");
    if(row.status==="completed")return {status:"completed" as const,result:decoded(row.result)};
    if(row.status!=="pending")throw new ArtifactError("CONFLICT");
    const target=await operation(request.name,caller.locale);
    if(target.operation.schemaHash!==prepared.schemaHash || target.kind!==prepared.kind ||
      (target.action?.approval??null)!==prepared.approval)throw new ArtifactError("CONFLICT");
    // Approval applies to the reviewed consequence, not a changed action.
    if (decision.approved) {
      let currentReview: z.infer<typeof CapabilityActionReviewSchema> | null = null;
      if (target.action?.review) {
        const response = await reviewCapabilityAction({appId:target.appId,capabilityId:target.localId,input:request.input,signal:caller.signal},caller);
        if (!response.ok) throw new Error(response.error.message);
        currentReview = CapabilityActionReviewSchema.parse(response.data);
      }
      if (JSON.stringify(currentReview)!==JSON.stringify(prepared.review)) throw new ArtifactError("CONFLICT");
    }
    if(decision.remember && (!prepared.allowAlways || (resource && resource.permission!=="admin")))throw new ArtifactError("INVALID_INPUT");
    const updated=await sql`UPDATE assistant.capability_calls SET status=${decision.approved?"running":"denied"}
      WHERE id=${id}::uuid AND user_id=${actor.id}::uuid AND status='pending' RETURNING id`;
    if(!updated.length)throw new ArtifactError("CONFLICT");
    if(!decision.approved)return {status:"denied" as const};
    if(decision.remember && prepared.scope)
      await rememberAiToolApproval({actorUserId:actor.id},{toolName:request.name,approvalScope:prepared.scope});
    const result=await invokeCapability({appId:prepared.appId,capabilityId:prepared.localId,kind:prepared.kind,input:request.input,
      ...(target.action?.idempotency==="required"?{idempotencyKey:`code-${id}`} : {}),signal:caller.signal},{...caller,requestId:id});
    await sql`UPDATE assistant.capability_calls SET status='completed',result=(${JSON.stringify(result)}::text)::jsonb WHERE id=${id}::uuid`;
    return {status:"completed" as const,result};
  },
};
