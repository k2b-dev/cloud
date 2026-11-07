import type { RuntimeCapabilityService } from "../capability-runtime";
import type { HttpApproval } from "../http-host";
export type CapabilityApproval = Extract<Awaited<ReturnType<RuntimeCapabilityService["prepare"]>>, { status: "approval" }>;
export type CapabilityDecision = { approved: boolean; remember?: "always" };
export type ApproveCapability = (request: CapabilityApproval, signal: AbortSignal, conversationId?: string) => Promise<CapabilityDecision>;

export type CodeApproval = CapabilityApproval | HttpApproval;
