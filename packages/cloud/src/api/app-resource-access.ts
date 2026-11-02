import { type Context, Hono } from "hono";
import { bindAppAccessRequest } from "../_internal/app-access-request";
import { hasLocalResourceAppAccess, resourceAccessApp } from "../_internal/app-access-resources";
import type { AppMeta } from "../contracts/app";
import { type AuthContext, auth, type RequestAuthority } from "../server/middleware/auth";
import { rateLimit } from "../server/middleware/rate-limit";
import { AppAccessUnavailableError, canUseApp } from "../services/app-access";
import { resolveInvocationAuthority } from "../services/identity/invocation-actor";
import { isInvocationJwtCandidate, verifyAppAccessProbe } from "../services/identity/invocation-token";

/** Framework-only endpoint, mounted before the app gate to avoid recursive entry checks. */
export const createResourceAppAccessRoutes = (app: Pick<AppMeta, "id" | "access">) => {
  const router = new Hono<AuthContext>();
  router.onError((error, c) => {
    if (!(error instanceof AppAccessUnavailableError)) throw error;
    c.header("Cache-Control", "private, no-store");
    return c.json({ code: error.code, app: error.app.id, message: error.message }, 503);
  });
  if (app.access?.kind === "resources")
    router.post("/check", auth.readOnly, async (c) => {
      c.header("Cache-Control", "private, no-store");
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token || !isInvocationJwtCandidate(token)) return c.body(null, 401);
      const claims = await verifyAppAccessProbe(token, app.id);
      if (!claims) return c.body(null, 401);
      if (!hasLocalResourceAppAccess(app.id)) return c.body(null, 403);
      const authority = await resolveInvocationAuthority(claims);
      if (!authority) return c.body(null, 401);
      return c.body(null, (await canUseApp(bindAppAccessRequest(authority, c.req.raw), app)) ? 204 : 403);
    });
  if (app.id === "core")
    router.post(
      "/apps/:appId",
      auth.readOnly,
      async (c, next) => {
        c.header("Cache-Control", "private, no-store");
        const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
        if (token && isInvocationJwtCandidate(token)) return c.body(null, 401);
        await next();
      },
      auth.requireRole("authenticated"),
      rateLimit(),
      (c) => answerCoreProbe(c, auth.getAuthority(c)),
    );
  return router;
};

const answerCoreProbe = async (c: Context<AuthContext>, authority: RequestAuthority): Promise<Response> => {
  const target = await resourceAccessApp(c.req.param("appId") ?? "", c.req.raw);
  if (!target || target.access?.kind !== "resources") return c.body(null, 404);
  return c.body(null, (await canUseApp(bindAppAccessRequest(authority, c.req.raw), target)) ? 204 : 403);
};
