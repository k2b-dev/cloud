import { type AuthContext, auth, getEffectiveGroups } from "@k2b/cloud/server";
import { authFlows } from "@k2b/cloud/services";
import { type Context, Hono } from "hono";
import { proxyAuthService } from "./service";

const getUserBackedActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  if (!actor) return null;
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

/**
 * Traefik ForwardAuth verify endpoint.
 *
 * Traefik sends a GET request with X-Forwarded-* headers.
 * - 200 + user headers = authenticated, request proceeds to upstream
 * - 302 = not authenticated, redirect to login
 * - 403 = authenticated but not authorized for this client
 */
const app = new Hono<AuthContext>().get("/verify/:clientId", auth.requireRole("*"), async (c) => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  const user = getUserBackedActor(c);
  const clientId = c.req.param("clientId");

  // Build original URL from Traefik headers when available.
  // Fallback to the current request URL for direct/local testing.
  const forwardedProto = c.req.header("X-Forwarded-Proto") ?? "https";
  const forwardedHost = c.req.header("X-Forwarded-Host");
  const forwardedUri = c.req.header("X-Forwarded-Uri") ?? "/";

  const originalUrl = (() => {
    if (!forwardedHost) return c.req.url;
    const path = forwardedUri.startsWith("/") ? forwardedUri : `/${forwardedUri}`;
    try {
      return new URL(path, `${forwardedProto}://${forwardedHost}`).toString();
    } catch {
      return c.req.url;
    }
  })();

  // Validate the forward-auth client before issuing any post-login return token.
  const client = await proxyAuthService.client.getByClientId({ clientId });
  if (!client) {
    return c.text("Unknown proxy auth client", 404);
  }

  // Not logged in → redirect to login with return URL
  if (!user) {
    if (actor) return c.text("Access denied: proxy auth requires a user-backed actor.", 403);
    const returnToken = await authFlows.proxyReturn.create({ clientId, url: originalUrl });
    if (!returnToken) {
      return c.text("Invalid proxy auth return URL", 400);
    }
    const returnPath = `/auth/proxy-return?token=${encodeURIComponent(returnToken)}`;
    const loginUrl = `/auth/login?redirectTo=${encodeURIComponent(returnPath)}`;
    return c.redirect(loginUrl, 302);
  }

  // Use the authoritative recursive membership graph for both the gate and
  // forwarded claims so nested memberships cannot disagree with each other.
  const effectiveGroups = await getEffectiveGroups({ userId: user.id });
  const effectiveGroupIds = new Set(effectiveGroups.map((group) => group.id));
  const hasAccess = client.allowedGroups.some((group) => effectiveGroupIds.has(group.id));

  if (!hasAccess) {
    return c.text("Access denied: you are not a member of an authorized group.", 403);
  }

  // Authenticated + authorized → 200 with user info headers
  c.header("X-Forwarded-User", user.uid);
  c.header("X-Forwarded-Email", user.mail ?? "");
  c.header("X-Forwarded-Groups", effectiveGroups.map((group) => group.name).join(","));
  return c.text("OK", 200);
});

export default app;
