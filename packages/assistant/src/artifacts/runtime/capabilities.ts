import type { HttpApproval } from "../http-host";
import { artifactClient } from "../client";
export type CapabilityApproval=Extract<Awaited<ReturnType<typeof artifactClient.capabilityPrepare>>,{status:"approval"}>;
export type CapabilityDecision={approved:boolean;remember?:"always"};
export type ApproveCapability=(request:CapabilityApproval,signal:AbortSignal,conversationId?:string)=>Promise<CapabilityDecision>;

export async function runCapability(name:string,input:unknown,context:{artifactId?:string;conversationId?:string},approve:ApproveCapability,signal:AbortSignal){
  signal.throwIfAborted();
  let response=await artifactClient.capabilityPrepare({id:crypto.randomUUID(),name,input,...context},signal);
  signal.throwIfAborted();
  if(response.status==="approval"){
    const id=response.id;
    try {
      const decision=await approve(response,signal,context.conversationId);
      signal.throwIfAborted();
      response=await artifactClient.capabilityResolve(id,decision,signal);
    } catch(error) {
      await artifactClient.capabilityResolve(id,{approved:false}).catch(()=>undefined);
      throw error;
    }
  }
  if(response.status!=="completed")throw new Error("Capability Action was rejected by the user.");
  const result=response.result;
  if(!result || typeof result!=="object" || !("ok" in result))throw new Error("Invalid capability result");
  if(!result.ok){
    const error="error" in result ? result.error : undefined;
    throw new Error(error && typeof error==="object" && "message" in error ? String(error.message) : "Capability failed");
  }
  return "data" in result ? result.data : null;
}

export type CodeApproval = CapabilityApproval | HttpApproval;
