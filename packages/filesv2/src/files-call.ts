import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { err } from "@k2b/stdlib";
import type { Context } from "hono";
import type { UserFilesCall, Via } from "./service/activity";

export function requestCall(c: Pick<Context<AuthContext>, "get" | "req">): UserFilesCall {
  const actor = c.get("actor");
  const delegation = actor.delegation;
  let via: Via;
  if (delegation?.kind === "invocation") via = delegation.mandateId || delegation.workloadType ? "agent" : `app:${delegation.callingAppId}`;
  else if (c.get("credentialKind") === "session")
    via = c.get("sessionKind") === "app" || (actor.kind === "user" && actor.sessionKind === "app") ? "app" : "web";
  // CLI stays api until the platform forwards the OAuth client identity.
  else via = "api";
  return {
    kind: "user",
    actor,
    accessSubject: c.get("accessSubject"),
    via,
    requestId: c.req.header("x-request-id")?.slice(0, 64) ?? delegation?.requestId ?? null,
    invocationId: delegation?.invocationId ?? null,
    callingApp: delegation?.callingAppId ?? null,
    origin: null,
  };
}

export function capabilityCall(c: CapabilityExecutionContext): UserFilesCall {
  if (c.actor.kind !== "user") throw err.forbidden("Files require a signed-in user.");
  const delegation = c.actor.delegation;
  return {
    kind: "user",
    actor: c.actor,
    accessSubject: c.accessSubject,
    via:
      c.origin === "assistant" || delegation?.mandateId || delegation?.workloadType
        ? "agent"
        : delegation
          ? `app:${delegation.callingAppId}`
          : "api",
    requestId: c.requestId,
    origin: c.origin,
    invocationId: delegation?.invocationId ?? null,
    callingApp: delegation?.callingAppId ?? null,
  };
}
