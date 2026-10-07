import { CapabilityStreamSchema } from "@k2b/cloud/contracts";
import { artifactClient } from "../client";
import type { HttpApproval } from "../http-host";
import { CloudError, cloudError } from "./errors";
export type CapabilityApproval = Extract<Awaited<ReturnType<typeof artifactClient.capabilityPrepare>>, { status: "approval" }>;
export type CapabilityDecision = { approved: boolean; remember?: "always" };
export type ApproveCapability = (request: CapabilityApproval, signal: AbortSignal, conversationId?: string) => Promise<CapabilityDecision>;

export async function runCapability(
  name: string,
  input: unknown,
  context: { artifactId?: string; conversationId?: string },
  approve: ApproveCapability,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const callId = crypto.randomUUID();
  let response = await artifactClient.capabilityPrepare({ id: callId, name, input, ...context }, signal);
  signal.throwIfAborted();
  if (response.status === "approval") {
    const id = response.id;
    try {
      const decision = await approve(response, signal, context.conversationId);
      signal.throwIfAborted();
      response = await artifactClient.capabilityResolve(id, decision, signal);
    } catch (error) {
      await artifactClient.capabilityResolve(id, { approved: false }).catch(() => undefined);
      throw error;
    }
  }
  if (response.status !== "completed") throw new CloudError("denied", "Capability Action was rejected by the user.");
  const result = response.result;
  if (!result || typeof result !== "object" || !("ok" in result)) throw new CloudError("unavailable", "Invalid capability result");
  if (!result.ok) {
    const error = "error" in result ? result.error : undefined;
    throw error && typeof error === "object" && "message" in error
      ? cloudError(error)
      : new CloudError("unavailable", "Invalid capability result");
  }
  const envelope = "data" in result ? result.data : null;
  if (envelope && typeof envelope === "object" && "stream" in envelope && envelope.stream) {
    return { ...envelope, stream: { ...CapabilityStreamSchema.parse(envelope.stream), callId } };
  }
  return envelope;
}

export type CodeApproval = CapabilityApproval | HttpApproval;
