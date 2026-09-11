import { AiChatActionsProvider, AiTurnBlockView } from "@k2b/cloud/ai/ui";
import { prompts } from "@k2b/ui";
import { createSignal, For, onCleanup } from "solid-js";
import type { ApproveCapability, CapabilityApproval, CapabilityDecision } from "./runtime/capabilities";

function Approval(props:{request:CapabilityApproval;respond:(value:CapabilityDecision)=>void}){
  return <AiChatActionsProvider actions={{onApproval:(_request,input)=>props.respond(input)}}>
    <AiTurnBlockView active turnId={props.request.id} block={{id:props.request.id,kind:"tool",callId:props.request.id,
      name:props.request.name,args:props.request.input,status:"awaiting_approval",
      approval:{message:props.request.review?.message??props.request.title,review:props.request.review??undefined,allowAlways:props.request.allowAlways}}}/>
  </AiChatActionsProvider>;
}

export const approveInModal:ApproveCapability=async(request,signal)=>{
  let decision:CapabilityDecision={approved:false};
  await prompts.dialog<void>(close=>{
    const abort=()=>close();signal.addEventListener("abort",abort,{once:true});
    onCleanup(()=>signal.removeEventListener("abort",abort));
    if(signal.aborted)close();
    return <Approval request={request} respond={value=>{decision=value;signal.removeEventListener("abort",abort);close();}}/>;
  },{title:request.title,size:"medium"});
  return decision;
};

export function createCodeApprovals(){
  type Pending={request:CapabilityApproval;conversationId?:string;respond:(value:CapabilityDecision)=>void};
  const [pending,setPending]=createSignal<Pending[]>([]);
  const ask:ApproveCapability=(request,signal,conversationId)=>new Promise((resolve,reject)=>{
    const remove=()=>setPending(items=>items.filter(item=>item.request.id!==request.id));
    const abort=()=>{remove();reject(new Error("Run stopped"));};
    signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted)return abort();
    setPending(items=>[...items,{request,conversationId,respond:value=>{signal.removeEventListener("abort",abort);remove();resolve(value);}}]);
  });
  const View=(props:{conversationId:string|null|undefined})=><For each={pending().filter(item=>item.conversationId===props.conversationId)}>{item=><Approval request={item.request} respond={item.respond}/>}</For>;
  return {ask,View};
}
