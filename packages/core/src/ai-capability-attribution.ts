import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { nestedInvocationLeases } from "@k2b/cloud/services/identity";

/** Attribution grants nothing. Retain the framework's source turn so nested
 * inference cannot escape a host-installed turn allowance. */
export async function aiCapabilityTurnAttribution(context: Pick<CapabilityExecutionContext, "actor" | "origin">) {
  if (context.actor.kind !== "user" || !context.actor.delegation) return undefined;
  // Stored Code invocations have their own attempt/day reservation. Session
  // invocations include Gustav and code_run, and retain their chat allowance.
  if (context.actor.delegation.credentialKind !== "session") return undefined;
  const lease = await nestedInvocationLeases.read(context.actor.delegation.invocationId);
  if (!lease && (context.origin === "assistant" || context.origin === "choice"))
    throw new Error("AI invocation lease is no longer available.");
  return lease?.assistantTurn ?? undefined;
}
