import { CapabilityStreamSchema } from "@k2b/cloud/contracts";
import type { ApproveCapability } from "../../chat-code/runtime/capabilities";
import { CloudError, cloudError } from "../../chat-code/runtime/errors";
import type { RuntimeSdkCallOptions } from "../../chat-code/runtime/services";
import { artifactClient } from "../client";

export type { ApproveCapability, CapabilityApproval, CapabilityDecision, CodeApproval } from "../../chat-code/runtime/capabilities";
export async function runCapability(
  name: string,
  input: unknown,
  context: { artifactId?: string; conversationId?: string },
  approve: ApproveCapability,
  signal: AbortSignal,
  options?: RuntimeSdkCallOptions,
) {
  signal.throwIfAborted();
  const callId = crypto.randomUUID();
  let response = await artifactClient.capabilityPrepare({ id: callId, name, input, ...options, ...context }, signal);
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
