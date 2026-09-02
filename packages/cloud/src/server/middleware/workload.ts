import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { WORKLOAD_SCOPES } from "../../services/identity/workload-auth";
import type { AuthContext } from "./auth";

const reservedWorkloadScopes = new Set<string>(WORKLOAD_SCOPES);

/** Reserved app workload keys are valid only at their dedicated Core authority routes. */
export const isReservedWorkloadCredential = (c: Context<AuthContext>): boolean => {
  const actor = c.get("actor");
  return (
    c.get("credentialKind") === "api_key" &&
    actor?.kind === "service_account" &&
    actor.serviceAccount.kind === "resource_bound" &&
    (c.get("credentialScopes") ?? []).some((scope) => reservedWorkloadScopes.has(scope))
  );
};

const reservedWorkloadResponse = (c: Context<AuthContext>): Response =>
  c.json({ code: "FORBIDDEN", message: "App workload credentials require a dedicated Core authority route" }, 403);

export const rejectReservedWorkloadCredential: MiddlewareHandler<AuthContext> = createMiddleware<AuthContext>(async (c, next) =>
  isReservedWorkloadCredential(c) ? reservedWorkloadResponse(c) : await next(),
);

/** Apply ordinary authentication first, then keep reserved workload keys out of legacy target routes. */
export const legacyCredentialBoundary = (authenticate: MiddlewareHandler<AuthContext>): MiddlewareHandler<AuthContext> =>
  createMiddleware<AuthContext>((c, next) =>
    authenticate(c, async () => {
      if (isReservedWorkloadCredential(c)) {
        c.res = reservedWorkloadResponse(c);
        return;
      }
      await next();
    }),
  );
