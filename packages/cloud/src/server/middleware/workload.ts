import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { hasReservedWorkloadScope } from "../../services/identity/workload-auth";
import type { AuthContext } from "./auth";

/** Reserved app workload keys are valid only at their dedicated Core authority routes. */
export const isReservedWorkloadCredential = (c: Context<AuthContext>): boolean => {
  const actor = c.get("actor");
  return (
    c.get("credentialKind") === "api_key" &&
    actor?.kind === "service_account" &&
    actor.serviceAccount.kind === "resource_bound" &&
    hasReservedWorkloadScope(c.get("credentialScopes") ?? [])
  );
};

const reservedWorkloadResponse = (c: Context<AuthContext>): Response =>
  c.json({ code: "FORBIDDEN", message: "App workload credentials require a dedicated Core authority route" }, 403);

export const rejectReservedWorkloadCredential: MiddlewareHandler<AuthContext> = createMiddleware<AuthContext>(async (c, next) =>
  isReservedWorkloadCredential(c) ? reservedWorkloadResponse(c) : await next(),
);
