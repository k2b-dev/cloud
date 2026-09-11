import type { CapabilityApproval, CapabilityDecision } from "./capabilities";
import { createRoot } from "solid-js";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { createArtifactAgentRuntime } from "../agent-runtime";

declare global {
  interface Window {
    assistantCodeApprove:(request:CapabilityApproval)=>Promise<CapabilityDecision>;
    assistantCodeExecute: (call: Parameters<AiFrontendToolHandler>[0]) => ReturnType<AiFrontendToolHandler>;
    assistantCodeCall: (call: Parameters<AiFrontendToolHandler>[0]) => ReturnType<AiFrontendToolHandler>;
  }
}

// The CLI owns this trusted browser page. User code only runs inside the same
// sandboxed iframe/worker used by the Assistant UI, never in this page or Bun.
createRoot(() => {
  const handlers = createArtifactAgentRuntime(null,request=>window.assistantCodeApprove(request));
  const standalone = createArtifactAgentRuntime(null,request=>window.assistantCodeApprove(request),"standalone");
  window.assistantCodeExecute = call => {
    const handler = standalone[call.name];
    if (!handler) throw new Error("Unknown code runtime operation");
    return handler(call);
  };
  window.assistantCodeCall = call => {
    const handler = handlers[call.name];
    if (!handler) throw new Error("Unknown code runtime operation");
    return handler(call);
  };
});
